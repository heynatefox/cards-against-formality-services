import { Errors, Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';
import dbMixin from '@cards-against-formality/db-mixin';

import Game, { Room, GameInterface } from './game';

export default class GameService extends Service {

  private gameService: Game = null;

  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'games',
        mixins: [
          dbMixin('games'),
          CacheCleaner([
            'cache.clean.games',
            'cache.clean.cards',
            'cache.clean.decks',
            'cache.clean.rooms',
          ])
        ],
        settings: {
          populates: {
            room: {
              action: 'rooms.get',
            }
          }
        },
        actions: {
          health: this.health,
          start: {
            params: {
              roomId: 'string'
            },
            handler: this.startGame
          },
          submit: {
            params: {
              clientId: 'string',
              roomId: 'string',
              cards: { type: 'array', items: 'string' }
            },
            handler: this.submitCards
          },
          winner: {
            params: {
              clientId: 'string',
              roomId: 'string',
              winnerId: 'string'
            },
            handler: this.selectWinner
          },
          reason: {
            params: {
              roomId: 'string',
              text: { type: 'string', min: 1, max: 500 }
            },
            handler: this.submitReason
          },
          leaderboard: {
            cache: { ttl: 60 },
            handler: this.getLeaderboard
          },
          reboot: {
            params: {
              roomId: 'string'
            },
            handler: this.rebootHand
          },
          'analytics-export': {
            params: {
              key: 'string',
              collection: { type: 'string', optional: true },
              limit: { type: 'number', optional: true, convert: true },
              skip: { type: 'number', optional: true, convert: true },
              outcome: { type: 'string', optional: true },
              reasoning: { type: 'string', optional: true }
            },
            handler: this.analyticsExport
          },
          'admin-stats': {
            params: {
              key: 'string'
            },
            handler: this.adminStats
          },
          'admin-login': {
            params: {
              username: 'string',
              password: 'string'
            },
            handler: this.adminLogin
          },
          'bug-report': {
            params: {
              bug: { type: 'string', min: 5, max: 1000 },
              route: { type: 'string', optional: true, max: 300 },
              context: { type: 'string', optional: true, max: 1000 }
            },
            handler: this.bugReport
          }
        },
        events: {
          'rooms.player.joined': this.handlePlayerJoined,
          'rooms.player.left': this.handlePlayerLeft,
          'rooms.removed': this.handleRoomRemoved,
          'games.turn.updated': ctx => {
            this.captureRound(ctx.params);
            return this.gameService.onTurnUpdated(ctx.params);
          }
        },
        entityCreated: this.entityCreated,
        entityUpdated: this.entityUpdated,
        entityRemoved: this.entityRemoved,
        started: () => {
          this.gameService = new Game(this.broker, this.logger);
          // Watchdog: revive games orphaned by restarts or dead timers.
          // First sweep soon after boot (deploys stall every active game),
          // then once a minute forever.
          const sweep = () => this.sweepStalledGames();
          this.watchdogInitial = setTimeout(sweep, 10 * 1000);
          this.watchdogInterval = setInterval(sweep, 60 * 1000);
          return null;
        },
        stopped: () => {
          if (this.watchdogInitial) {
            clearTimeout(this.watchdogInitial);
          }
          if (this.watchdogInterval) {
            clearInterval(this.watchdogInterval);
          }
          return null;
        }
      },
    );
  }

  private watchdogInitial: NodeJS.Timer = null;
  private watchdogInterval: NodeJS.Timer = null;
  private sweeping = false;

  /**
   * Fetch every live game doc and hand them to the watchdog. Games whose
   * phase deadline has passed without a state change get their timers
   * re-armed from persisted state; orphans get destroyed. Re-entrancy
   * guarded: draining a large backlog can outlast the interval, and
   * overlapping sweeps would flood the broker.
   *
   * @private
   * @memberof GameService
   */
  private async sweepStalledGames() {
    if (this.sweeping) {
      return null;
    }
    this.sweeping = true;
    try {
      const games: any[] = await this.broker.call('games.find', { query: {} });
      if (games && games.length) {
        await this.gameService.resumeStalledGames(games);
      }
      return null;
    } catch (err) {
      this.logger.warn(`watchdog sweep failed: ${err.message}`);
      return null;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Humor-dataset capture: every completed round (winner picked, no-winner,
   * or game end) is written to the `round_analytics` collection in the same
   * database. Player ids are hashed with ANALYTICS_SALT — capture is a NO-OP
   * until that env var is set. Fire-and-forget; never affects gameplay.
   *
   * Row shape (v1): black card, every submission (populated card text), the
   * winner, per-player hands at time of capture (card ids), scores, and an
   * extensible `signals` object for future reasoning/reaction data.
   *
   * @private
   * @param {*} turn  the games.turn.updated payload (TurnDataWithState)
   * @memberof GameService
   */
  private async captureRound(turn: any) {
    try {
      const salt = process.env.ANALYTICS_SALT;
      if (!salt) {
        return;
      }
      // Only completed rounds carry signal: a winner announcement (turnSetup
      // with winner set), a failed round (errorMessage), or the game end.
      const isRoundEnd = turn?.state === 'turnSetup' && !turn?.initializing && (turn?.winner || turn?.errorMessage);
      const isGameEnd = turn?.state === 'ended';
      if (!isRoundEnd && !isGameEnd) {
        return;
      }
      // Abandoned games auto-advance empty rounds forever; a round with no
      // submissions and no winner carries zero humor signal. Don't hoard it.
      const submissionCount = Object.keys(turn?.selectedCards ?? {}).length;
      if (isRoundEnd && !turn?.winner && submissionCount === 0) {
        return;
      }

      // tslint:disable-next-line: no-var-requires
      const { createHash } = require('crypto');
      const hash = (id: string) => id ? createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 16) : null;

      // Hands (card ids) come from the game doc — one read per round
      const game: any = await this.broker.call('games.get', { id: turn.gameId }).catch(() => null);
      const hands = {};
      if (game?.players) {
        Object.values(game.players).forEach((p: any) => {
          hands[hash(p._id)] = p.cards ?? [];
        });
      }

      const row = {
        v: 1,
        ts: Date.now(),
        gameId: turn.gameId,
        roomId: String(turn.roomId ?? ''),
        turn: turn.turn,
        outcome: isGameEnd ? 'game_end' : (turn.winner ? 'winner' : 'no_winner'),
        blackCard: turn.blackCard ? { id: turn.blackCard._id, text: turn.blackCard.text, pick: turn.blackCard.pick } : null,
        submissions: Object.entries(turn.selectedCards ?? {}).map(([playerId, cards]: [string, any]) => ({
          player: hash(playerId),
          isRando: playerId === 'rando-cardrissian',
          cards: (cards ?? []).map((c: any) => ({ id: c._id, text: c.text })),
        })),
        winner: Array.isArray(turn.winner) ? turn.winner.map(hash) : hash(turn.winner),
        players: (turn.players ?? []).map((p: any) => ({ id: hash(p._id), score: p.score })),
        hands,
        context: {
          roundTime: game?.roundTime ?? null,
          playerCount: (turn.players ?? []).length,
          errorMessage: turn.errorMessage ?? null,
          // Which card-tag set the stratified dealer was using (analysis
          // joins card ids against this tagset version offline)
          tagset: 'v0',
        },
        signals: {},
      };

      const db = (this.adapter as any)?.db;
      if (db) {
        await db.collection('round_analytics').insertOne(row);
      }
    } catch (err) {
      this.logger.warn(`captureRound failed: ${err.message}`);
    }
  }

  /**
   * "Explain yourself." — the czar defends their winner pick. Scored by a
   * deliberately unscientific heuristic (deterministic, so the client's gauge
   * animation can land on the same number). Reasoning is attached to the
   * captured round's `signals` (dataset) and rolled into the weekly humor
   * leaderboard (product).
   *
   * @private
   * @memberof GameService
   */
  private scoreReasoning(text: string): number {
    const t = text.trim();
    if (t.length < 8) return 7; // one-worders: your humor is shit
    const words = t.toLowerCase().split(/\s+/);
    const unique = new Set(words).size;
    let score = Math.min(38, t.length / 4);      // effort
    score += Math.min(26, unique * 2.2);          // vocabulary
    if (words.length >= 12) score += 10;          // committed to the bit
    if (/[?!]/.test(t)) score += 4;               // punctuation is passion
    if (words.length < 6 && /\b(lol|lmao|idk|funny|dunno|whatever|cuz|because)\b/i.test(t)) {
      score = Math.min(score, 22);                // low-effort tells
    }
    // deterministic chaos: same text always lands the same place
    let h = 0;
    for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) | 0; }
    score += Math.abs(h % 17);
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  private verdictFor(score: number): string {
    if (score < 25) return 'Your humor is shit.';
    if (score < 50) return 'Certified hack';
    if (score < 75) return 'Dangerously funny';
    return 'Comedic god';
  }

  private weekKey(): string {
    const d = new Date();
    const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((d.getTime() - jan1.getTime()) / 86400000) + jan1.getUTCDay() + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  private async submitReason(ctx: Context<{ roomId: string; text: string }, { user: { uid: string } }>) {
    const { roomId, text } = ctx.params;
    const uid = ctx.meta.user.uid;

    const game: any = await this.getGameMatchingRoom(ctx, roomId);
    const prev = game?.prevTurnData;
    // Only the czar of the just-completed round may explain themselves
    if (!prev || prev.czar !== uid) {
      throw new Errors.MoleculerError('Only the Czar explains themselves', 403, 'NOT_THE_CZAR');
    }

    const clean = text.trim().slice(0, 500);
    const score = this.scoreReasoning(clean);
    const verdict = this.verdictFor(score);
    const db = (this.adapter as any)?.db;

    // Dataset: attach to the captured round (exists only when ANALYTICS_SALT set)
    if (db && process.env.ANALYTICS_SALT) {
      db.collection('round_analytics')
        .updateOne(
          { gameId: String(game._id), turn: prev.turn },
          { $set: { 'signals.czarReasoning': { text: clean, score, verdict, ts: Date.now() } } }
        )
        .catch((err: any) => this.logger.warn(`reason capture failed: ${err.message}`));
    }

    // Product: weekly leaderboard (usernames are public in-game already)
    if (db) {
      const username = await ctx.call<any, any>('clients.get', { id: uid })
        .then((c: any) => c?.username)
        .catch(() => null);
      if (username) {
        db.collection('humor_leaderboard')
          .updateOne(
            { week: this.weekKey(), uid },
            {
              $set: { username, lastVerdict: verdict, updatedAt: Date.now() },
              $max: { bestScore: score },
              $inc: { totalScore: score, defenses: 1 },
            },
            { upsert: true }
          )
          .catch((err: any) => this.logger.warn(`leaderboard update failed: ${err.message}`));
      }
    }

    return { score, verdict };
  }

  private async getLeaderboard() {
    const db = (this.adapter as any)?.db;
    if (!db) {
      return { week: this.weekKey(), entries: [] };
    }
    const entries = await db.collection('humor_leaderboard')
      .find({ week: this.weekKey() })
      .sort({ bestScore: -1, totalScore: -1 })
      .limit(10)
      .project({ _id: 0, username: 1, bestScore: 1, defenses: 1, lastVerdict: 1 })
      .toArray()
      .catch(() => []);
    return { week: this.weekKey(), entries };
  }

  private async startGame(ctx: Context<{ roomId: string }, { user: { uid: string } }>) {
    const { roomId } = ctx.params;
    const clientId = ctx.meta.user.uid;
    // TOOD: add check to ensure only host can start the game.
    // Check if the required number of players are in the game before starting.
    let _room: Room;
    try {
      _room = await ctx.call('rooms.get', { id: roomId });
    } catch (err) {
      throw new Error(`Room not found: ${roomId}`);
    }
    if (_room.players.length < 2) {
      throw new Error('Not enough Players');
    }

    if (_room.host !== clientId) {
      throw new Error('Only the host can start the game');
    }

    return this.gameService.onGameStart(_room)
      .then(() => ({ message: 'Game successfully started' }))
      .catch(err => {
        this.logger.error(err);
        throw new Error('Failed to start game');
      });
  }

  private getGameMatchingRoom(ctx: Context, roomId: string): Promise<GameInterface> {
    return ctx.call(`${this.name}.find`, { query: { room: roomId }, populate: ['room'] })
      .then((games: GameInterface[]) => {
        if (!games?.length) {
          throw new Error('Unable to find game');
        }
        this.logger.info(games[0].room);
        return games[0];
      })
      .catch(err => {
        throw err;
      });
  }

  /**
   * House rule "Rebooting the Universe": pay one point, swap your whole hand.
   * Allowed for non-czar players who haven't played this round and have a
   * point to burn, in rooms with the rule enabled.
   *
   * @private
   * @param {Context<{ roomId: string }, any>} ctx
   * @memberof GameService
   */
  /**
   * Key-protected export of the humor dataset. No-ops (404) unless
   * ANALYTICS_EXPORT_KEY is set and matches. collection: 'summary'
   * (default) | 'rounds' | 'leaderboard'.
   *
   * @private
   * @param {Context<{ key: string; collection?: string; limit?: number }>} ctx
   * @memberof GameService
   */
  private async analyticsExport(ctx: Context<{ key: string; collection?: string; limit?: number; skip?: number; outcome?: string; reasoning?: string }>) {
    const configured = process.env.ANALYTICS_EXPORT_KEY;
    if (!configured || ctx.params.key !== configured) {
      throw new Errors.MoleculerError('Not found', 404, 'NOT_FOUND');
    }
    const db = (this.adapter as any) && (this.adapter as any).db;
    if (!db) {
      throw new Errors.MoleculerError('Storage unavailable', 500, 'NO_DB');
    }

    const collection = ctx.params.collection || 'summary';
    const limit = Math.min(ctx.params.limit || 500, 2000);
    const skip = Math.max(0, (ctx.params as any).skip || 0);

    if (collection === 'rounds') {
      const query: any = {};
      if (ctx.params.outcome) {
        query.outcome = ctx.params.outcome;
      }
      if (ctx.params.reasoning === '1') {
        query['signals.czarReasoning'] = { $exists: true };
      }
      return db.collection('round_analytics').find(query).sort({ ts: -1 }).skip(skip).limit(limit).toArray();
    }
    if (collection === 'leaderboard') {
      return db.collection('humor_leaderboard').find({}).sort({ bestScore: -1 }).limit(limit).toArray();
    }
    if (collection === 'bugs') {
      return db.collection('bug_reports').find({}).sort({ ts: -1 }).skip(skip).limit(limit).toArray();
    }

    // summary: shape of the dataset at a glance
    const rounds = db.collection('round_analytics');
    const total = await rounds.countDocuments({});
    const withReasoning = await rounds.countDocuments({ 'signals.czarReasoning': { $exists: true } });
    const outcomes = await rounds.aggregate([
      { $group: { _id: '$outcome', n: { $sum: 1 } } }
    ]).toArray();
    const verdicts = await rounds.aggregate([
      { $match: { 'signals.czarReasoning': { $exists: true } } },
      { $group: { _id: '$signals.czarReasoning.verdict', n: { $sum: 1 }, avgScore: { $avg: '$signals.czarReasoning.score' } } },
      { $sort: { n: -1 } }
    ]).toArray();
    const range = await rounds.aggregate([
      { $group: { _id: null, first: { $min: '$ts' }, last: { $max: '$ts' }, games: { $addToSet: '$gameId' }, avgPlayers: { $avg: '$context.playerCount' } } }
    ]).toArray();
    const leaderboardCount = await db.collection('humor_leaderboard').countDocuments({});

    const r = range && range[0];
    return {
      rounds: total,
      distinctGames: r && r.games ? r.games.length : 0,
      firstRoundAt: r ? r.first : null,
      lastRoundAt: r ? r.last : null,
      avgPlayersPerRound: r ? r.avgPlayers : null,
      outcomes,
      reasoning: { rounds: withReasoning, coverage: total ? withReasoning / total : 0, verdicts },
      leaderboardEntries: leaderboardCount,
    };
  }

  /**
   * Dashboard payload for the admin portal. Same key gate as the export.
   * Every section is best-effort: services share one Mongo database, so the
   * games adapter can usually read clients/rooms too; if a collection is
   * elsewhere the section comes back null instead of failing the request.
   *
   * @private
   * @param {Context<{ key: string }>} ctx
   * @memberof GameService
   */
  private async adminStats(ctx: Context<{ key: string }>) {
    const configured = process.env.ANALYTICS_EXPORT_KEY;
    if (!configured || ctx.params.key !== configured) {
      throw new Errors.MoleculerError('Not found', 404, 'NOT_FOUND');
    }
    const db = (this.adapter as any) && (this.adapter as any).db;
    if (!db) {
      throw new Errors.MoleculerError('Storage unavailable', 500, 'NO_DB');
    }

    // Every section is time-boxed: a slow or wedged dependency nulls that
    // section instead of hanging the whole dashboard.
    const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await Promise.race([
          fn(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('section timeout')), 8000)),
        ]);
      } catch (err) {
        this.logger.warn(`admin-stats section '${name}' failed: ${err.message}`);
        return null;
      }
    };

    const rounds = db.collection('round_analytics');
    const dayMs = 24 * 60 * 60 * 1000;

    const [users, live, activity, games, reasoning, leaderboard, recentRounds] = await Promise.all([
      section('users', async () => {
        // Each service owns its own database; go through the broker
        const total: number = await ctx.call('clients.count', { query: {} });
        const anonymous: number = await ctx.call('clients.count', { query: { isAnonymous: true } });
        const optedIn: number = await ctx.call('clients.count', { query: { marketingOptIn: true } });
        return { total, anonymous, registered: total - anonymous, optedIn };
      }),
      section('live', async () => {
        const roomDocs: any[] = await ctx.call('rooms.find', { query: {} });
        const withPlayers = roomDocs.filter((r: any) => (r.players || []).length > 0);
        return {
          rooms: roomDocs.length,
          activeRooms: withPlayers.length,
          playersSeated: roomDocs.reduce((n: number, r: any) => n + (r.players || []).length, 0),
          liveGames: await db.collection('games').countDocuments({}),
        };
      }),
      section('activity', async () => {
        // Rounds per day (winner rounds = real play), last 14 days
        const since = Date.now() - 14 * dayMs;
        const daily = await rounds.aggregate([
          { $match: { ts: { $gte: since }, outcome: 'winner' } },
          { $group: { _id: { $floor: { $divide: ['$ts', dayMs] } }, n: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ]).toArray();
        return daily.map((d: any) => ({ day: new Date(d._id * dayMs).toISOString().slice(0, 10), rounds: d.n }));
      }),
      section('games', async () => {
        const total = await rounds.countDocuments({});
        const winnerRounds = await rounds.countDocuments({ outcome: 'winner' });
        // Per-game span: rounds count + duration from first to last capture
        const perGame = await rounds.aggregate([
          { $match: { outcome: 'winner' } },
          { $group: { _id: '$gameId', rounds: { $sum: 1 }, first: { $min: '$ts' }, last: { $max: '$ts' }, players: { $avg: '$context.playerCount' } } }
        ]).toArray();
        const games2 = perGame.length;
        const avgRounds = games2 ? perGame.reduce((n: number, g: any) => n + g.rounds, 0) / games2 : 0;
        const avgDurationMin = games2
          ? perGame.reduce((n: number, g: any) => n + Math.max(0, g.last - g.first), 0) / games2 / 60000
          : 0;
        const avgPlayers = games2 ? perGame.reduce((n: number, g: any) => n + (g.players || 0), 0) / games2 : 0;
        return { capturedRounds: total, winnerRounds, gamesWithPlay: games2, avgRoundsPerGame: avgRounds, avgGameDurationMin: avgDurationMin, avgPlayers };
      }),
      section('reasoning', async () => {
        const defenses = await rounds.countDocuments({ 'signals.czarReasoning': { $exists: true } });
        const verdicts = await rounds.aggregate([
          { $match: { 'signals.czarReasoning': { $exists: true } } },
          { $group: { _id: '$signals.czarReasoning.verdict', n: { $sum: 1 }, avgScore: { $avg: '$signals.czarReasoning.score' } } },
          { $sort: { n: -1 } }
        ]).toArray();
        return { defenses, verdicts };
      }),
      section('leaderboard', () => db.collection('humor_leaderboard').find({}).sort({ bestScore: -1 }).limit(10).toArray()),
      section('recentRounds', () => rounds.find({ outcome: 'winner' }).sort({ ts: -1 }).limit(25).toArray()),
    ]);

    return { generatedAt: Date.now(), users, live, activity, games, reasoning, leaderboard, recentRounds };
  }

  /**
   * Portal login: username + password (stored as a sha256 hash in env)
   * exchanged for the analytics key. Constant-time compares, a flat delay
   * against brute force, and one generic error for every failure mode.
   *
   * @private
   * @param {Context<{ username: string; password: string }>} ctx
   * @memberof GameService
   */
  private async adminLogin(ctx: Context<{ username: string; password: string }>) {
    // tslint:disable-next-line: no-var-requires
    const { createHash, timingSafeEqual } = require('crypto');
    const user = process.env.ADMIN_USER;
    const passHash = process.env.ADMIN_PASS_SHA256;
    const key = process.env.ANALYTICS_EXPORT_KEY;

    await new Promise(resolve => setTimeout(resolve, 400));

    const fail = () => { throw new Errors.MoleculerError('Nope.', 401, 'BAD_LOGIN'); };
    if (!user || !passHash || !key) {
      fail();
    }
    const given = createHash('sha256').update(ctx.params.password).digest('hex');
    const a = Buffer.from(given);
    const b = Buffer.from(passHash);
    const passOk = a.length === b.length && timingSafeEqual(a, b);
    const userOk = ctx.params.username === user;
    if (!passOk || !userOk) {
      fail();
    }
    return { key };
  }

  /**
   * In-app bug reporter (replaced Netlify Forms, which bills past 100
   * submissions/month). Public, gateway-rate-limited, fire-and-forget.
   *
   * @private
   * @param {Context<{ bug: string; route?: string; context?: string }>} ctx
   * @memberof GameService
   */
  private async bugReport(ctx: Context<{ bug: string; route?: string; context?: string }>) {
    const db = (this.adapter as any) && (this.adapter as any).db;
    if (!db) {
      throw new Errors.MoleculerError('Storage unavailable', 500, 'NO_DB');
    }
    await db.collection('bug_reports').insertOne({
      ts: Date.now(),
      bug: ctx.params.bug.trim(),
      route: ctx.params.route || null,
      context: ctx.params.context || null,
    });
    return { message: 'Filed. A human reads these on Mondays.' };
  }

  private async rebootHand(ctx: Context<{ roomId: string }, { user: { uid: string } }>) {
    const { roomId } = ctx.params;
    const uid = ctx.meta.user.uid;

    const game: any = await this.getGameMatchingRoom(ctx, roomId);
    const options = game.room && game.room.options;
    if (!options || !options.rebootingUniverse) {
      throw new Errors.MoleculerError('Rebooting the Universe is not enabled in this room', 400, 'RULE_DISABLED');
    }
    const player = game.players && game.players[uid];
    if (!player) {
      throw new Errors.MoleculerError('You are not in this game', 403, 'NOT_IN_GAME');
    }
    if (game.turnData && game.turnData.czar === uid) {
      throw new Errors.MoleculerError('The Czar cannot reboot mid-judgment', 400, 'CZAR_CANNOT_REBOOT');
    }
    if (game.selectedCards && uid in game.selectedCards) {
      throw new Errors.MoleculerError('You already played this round', 400, 'ALREADY_PLAYED');
    }
    if ((player.score || 0) < 1) {
      throw new Errors.MoleculerError('Costs one point. You have none.', 400, 'NO_POINTS');
    }

    return this.gameService.rebootPlayerHand(game, uid);
  }

  private async submitCards(ctx: Context<{ clientId: string; roomId: string; cards: string[] }, any>) {
    const { roomId, cards, clientId } = ctx.params;
    if (clientId !== ctx.meta.user.uid) {
      return Promise.reject(new Errors.MoleculerError('You cannot submit a card for another user.', 401))
    }

    const game: any = await this.getGameMatchingRoom(ctx, roomId);
    await this.gameService.onHandSubmitted(game, clientId, cards);
    return { message: 'Cards successfully submitted' };
  }

  private async selectWinner(ctx: Context<{ clientId: string; roomId: string; winnerId: string }>) {
    const { clientId, roomId, winnerId } = ctx.params;
    const game: any = await this.getGameMatchingRoom(ctx, roomId);
    await this.gameService.onWinnerSelected(game, winnerId, clientId);
    return { message: 'Winner selected' };
  }

  private async handlePlayerJoined(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    return this.getGameMatchingRoom(ctx, roomId)
      .then((game) => {
        return this.gameService.onPlayerJoin(game, clientId);
      })
      .catch(err => {
        // game must not have started yet.
      });
  }

  private handlePlayerLeft(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    return this.getGameMatchingRoom(ctx, roomId)
      .then((game) => {
        return this.gameService.onPlayerLeave(
          game,
          clientId,
          this.adapter,
          json => this.entityChanged('updated', json, ctx).then(() => json)
        );
      })
      .catch(err => {
        // game must not have started yet.
      });
  }

  private async handleRoomRemoved(ctx: Context<{ _id: string }>) {
    return this.getGameMatchingRoom(ctx, ctx.params._id)
      .then((game) => this.gameService.destroyGame(game._id))
      .catch(() => {
        // game must not have started yet.
      });
  }

  /**
   * Get the health data for this service.
   *
   * @private
   * @param {Context} ctx
   * @returns {Promise<NodeHealthStatus>}
   * @memberof DecksService
   */
  private health(ctx: Context): Promise<NodeHealthStatus> {
    return ctx.call('$node.health');
  }

  /**
   * Emit an event when a Card is created.
   *
   * @private
   * @param {*} json
   * @param {Context} ctx
   * @returns
   * @memberof ClientsService
   */
  private entityCreated(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.created`, json);
  }

  /**
   * Emit an event when a card is updated.
   *
   * @private
   * @param {*} json
   * @param {Context} ctx
   * @returns
   * @memberof ClientsService
   */
  private entityUpdated(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.updated`, json);
  }

  /**
   * Emit an event when a Card is removed.
   *
   * @private
   * @param {*} json
   * @param {Context} ctx
   * @returns
   * @memberof ClientsService
   */
  private entityRemoved(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.removed`, json);
  }
}
