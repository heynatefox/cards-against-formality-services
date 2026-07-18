import { Errors, Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';
import dbMixin from '@cards-against-formality/db-mixin';

import Game, { Room, GameInterface } from './game';
import * as cardTags from './data/card-tags-v0.json';

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
          },
          'promo-event': {
            params: {
              type: { type: 'enum', values: ['impression', 'click'] },
              property: { type: 'string', max: 20 },
              variant: { type: 'string', max: 20 },
              placement: { type: 'string', max: 20 }
            },
            handler: this.promoEvent
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
  private normReasoning(s: string): string {
    return s.toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').replace(/ +/g, ' ').trim();
  }

  /**
   * Paste detection: players discovered the gauge rewarded length and started
   * pasting the prompt card / winning card / czar-screen copy into the box.
   * A defense that is mostly someone else's words scores a flat 2.
   */
  private isPastedDefense(text: string, context: string[]): boolean {
    const nt = this.normReasoning(text);
    const words = nt.split(' ').filter(w => w.length > 0);
    const uiCopy = ['select your favorite answer', 'you are the card czar', 'the czar is deciding', 'waiting for players to play'];
    const sources = context.concat(uiCopy).map(s => this.normReasoning(s)).filter(s => s.length >= 12);
    for (const src of sources) {
      // whole defense is a chunk of the source, or the source dominates the defense
      if (nt.length >= 12 && src.indexOf(nt) !== -1) { return true; }
      if (nt.indexOf(src) !== -1 && src.length >= nt.length * 0.5) { return true; }
      // token overlap: most meaningful words lifted from one source
      const srcTokens = new Set(src.split(' '));
      const meaty = words.filter(w => w.length >= 3);
      if (meaty.length >= 5 && meaty.filter(w => srcTokens.has(w)).length / meaty.length >= 0.6) { return true; }
    }
    return false;
  }

  private scoreReasoning(text: string, context: string[] = []): number {
    const t = text.trim();
    if (t.length < 8) return 7; // one-worders: your humor is shit
    if (this.isPastedDefense(t, context)) { return 2; } // clipboard is not comedy
    const words = this.normReasoning(t).split(' ').filter(w => w.length > 0);
    const unique = new Set(words);
    const uniqueRatio = words.length ? unique.size / words.length : 0;
    let score = Math.min(40, unique.size * 2.5);  // depth: distinct words, not characters
    score += Math.min(16, words.length * 0.8);    // length still counts, a little
    if (words.length >= 12 && uniqueRatio >= 0.7) score += 10; // committed AND varied
    if (/[?!]/.test(t)) score += 4;               // punctuation is passion
    if (words.length >= 8 && uniqueRatio < 0.5) {
      score = Math.min(score, 30);                // "ha ha ha ha" farms nothing
    }
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
    // Round texts the czar could paste-farm: the prompt and every submission
    const contextTexts: string[] = [];
    if (prev.blackCard?.text) {
      contextTexts.push(prev.blackCard.text);
    }
    Object.values(prev.selectedCards ?? {}).forEach((cards: any) => {
      (cards ?? []).forEach((c: any) => { if (c?.text) { contextTexts.push(c.text); } });
    });
    const score = this.scoreReasoning(clean, contextTexts);
    const verdict = this.verdictFor(score);
    const db = (this.adapter as any)?.db;

    // Dataset: attach to the captured round (exists only when ANALYTICS_SALT set)
    if (db && process.env.ANALYTICS_SALT) {
      db.collection('round_analytics')
        .updateOne(
          { gameId: String(game._id), turn: prev.turn },
          { $set: { 'signals.czarReasoning': { text: clean, score, verdict, pasted: score === 2, ts: Date.now() } } }
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
    if (collection === 'styles') {
      return this.styleStats(db, Math.min(ctx.params.limit || 3000, 10000));
    }
    if (collection === 'cards') {
      return this.cardStats(db, Math.min(ctx.params.limit || 5000, 15000));
    }
    if (collection === 'promos') {
      return this.promoStats(db);
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
   * Humor-style aggregation over recent judged rounds, joining card ids
   * against the v0 tagset baked into the build. Two rates per style:
   * winRate (of plays, how many won the round) and playRate (of times a
   * style was in someone's hand, how often it got played — the stratified
   * dealer makes this denominator meaningful). Rando plays are excluded;
   * bot picks are noise in a preference measure.
   *
   * @private
   * @memberof GameService
   */
  private async styleStats(db: any, sample: number) {
    const tags = cardTags as { [id: string]: { t: string[]; i: number } };
    const rows = await db.collection('round_analytics')
      .find({ outcome: 'winner' })
      .sort({ ts: -1 })
      .limit(sample)
      .project({ submissions: 1, winner: 1, hands: 1, ts: 1 })
      .toArray();

    const byStyle: { [s: string]: { played: number; wins: number; held: number } } = {};
    const bucket = (s: string) => byStyle[s] || (byStyle[s] = { played: 0, wins: 0, held: 0 });
    let taggedPlays = 0;
    let untaggedPlays = 0;

    for (const r of rows) {
      const winners = new Set(Array.isArray(r.winner) ? r.winner : [r.winner]);
      for (const sub of r.submissions || []) {
        if (sub.isRando) {
          continue;
        }
        const won = winners.has(sub.player);
        for (const c of sub.cards || []) {
          const tag = tags[c.id];
          if (!tag) { untaggedPlays++; continue; }
          taggedPlays++;
          const b = bucket(tag.t[0]);
          b.played++;
          if (won) { b.wins++; }
        }
      }
      // Hands are card ids still held at round end — the road not taken
      for (const handIds of Object.values(r.hands || {})) {
        for (const id of handIds as string[]) {
          const tag = tags[id];
          if (tag) { bucket(tag.t[0]).held++; }
        }
      }
    }

    const styles = Object.entries(byStyle).map(([style, b]) => ({
      style,
      played: b.played,
      wins: b.wins,
      winRate: b.played ? b.wins / b.played : 0,
      playShare: taggedPlays ? b.played / taggedPlays : 0,
      playRate: (b.played + b.held) ? b.played / (b.played + b.held) : 0,
    })).sort((x, y) => y.winRate - x.winRate);

    return {
      roundsAnalyzed: rows.length,
      windowFrom: rows.length ? rows[rows.length - 1].ts : null,
      windowTo: rows.length ? rows[0].ts : null,
      taggedPlays,
      untaggedPlays,
      tagset: 'v0',
      styles,
    };
  }

  /**
   * Card popularity over recent judged rounds: most-played white cards,
   * best win rate (min plays gate so 2-for-2 flukes don't top the chart),
   * and most-seen prompts. Rando plays excluded — bot picks are random.
   *
   * @private
   * @memberof GameService
   */
  private async cardStats(db: any, sample: number) {
    const rows = await db.collection('round_analytics')
      .find({ outcome: 'winner' })
      .sort({ ts: -1 })
      .limit(sample)
      .project({ submissions: 1, winner: 1, blackCard: 1, ts: 1 })
      .toArray();

    const white: { [id: string]: { text: string; played: number; wins: number } } = {};
    const prompts: { [id: string]: { text: string; rounds: number } } = {};

    for (const r of rows) {
      const winners = new Set(Array.isArray(r.winner) ? r.winner : [r.winner]);
      if (r.blackCard && r.blackCard.id) {
        const p = prompts[r.blackCard.id] || (prompts[r.blackCard.id] = { text: r.blackCard.text, rounds: 0 });
        p.rounds++;
      }
      for (const sub of r.submissions || []) {
        if (sub.isRando) { continue; }
        const won = winners.has(sub.player);
        for (const c of sub.cards || []) {
          if (!c || !c.id) { continue; }
          const w = white[c.id] || (white[c.id] = { text: c.text, played: 0, wins: 0 });
          w.played++;
          if (won) { w.wins++; }
        }
      }
    }

    const whiteArr = Object.entries(white).map(([id, w]) => ({
      id, text: w.text, played: w.played, wins: w.wins,
      winRate: w.played ? w.wins / w.played : 0,
    }));
    const MIN_PLAYS = 10;
    return {
      roundsAnalyzed: rows.length,
      windowFrom: rows.length ? rows[rows.length - 1].ts : null,
      windowTo: rows.length ? rows[0].ts : null,
      distinctWhiteCards: whiteArr.length,
      topPlayed: whiteArr.slice().sort((a, b) => b.played - a.played).slice(0, 25),
      topWinRate: whiteArr.filter(w => w.played >= MIN_PLAYS)
        .sort((a, b) => b.winRate - a.winRate).slice(0, 25),
      minPlaysForWinRate: MIN_PLAYS,
      topPrompts: Object.entries(prompts)
        .map(([id, p]) => ({ id, text: p.text, rounds: p.rounds }))
        .sort((a, b) => b.rounds - a.rounds).slice(0, 15),
    };
  }

  /**
   * Promo A/B rollup from our own promo_events mirror (GA-independent).
   * Impressions, clicks, and CTR per property / creative / placement.
   *
   * @private
   * @memberof GameService
   */
  private async promoStats(db: any) {
    const agg = await db.collection('promo_events').aggregate([
      { $group: {
        _id: { property: '$property', variant: '$variant', placement: '$placement', type: '$type' },
        n: { $sum: 1 },
        first: { $min: '$ts' },
        last: { $max: '$ts' },
      } }
    ]).toArray();

    const rows: { [key: string]: any } = {};
    let from: number | null = null;
    let to: number | null = null;
    for (const a of agg) {
      const k = `${a._id.property}|${a._id.variant}|${a._id.placement}`;
      const row = rows[k] || (rows[k] = {
        property: a._id.property, variant: a._id.variant, placement: a._id.placement,
        impressions: 0, clicks: 0,
      });
      if (a._id.type === 'impression') { row.impressions = a.n; }
      if (a._id.type === 'click') { row.clicks = a.n; }
      if (from === null || a.first < from) { from = a.first; }
      if (to === null || a.last > to) { to = a.last; }
    }
    const detail = Object.values(rows).map((r: any) => ({
      ...r, ctr: r.impressions ? r.clicks / r.impressions : 0,
    })).sort((x: any, y: any) => y.impressions - x.impressions);

    // Property-level rollup: the headline of the test
    const byProperty: { [p: string]: { impressions: number; clicks: number } } = {};
    for (const r of detail) {
      const p = byProperty[r.property] || (byProperty[r.property] = { impressions: 0, clicks: 0 });
      p.impressions += r.impressions;
      p.clicks += r.clicks;
    }
    return {
      since: from, until: to,
      properties: Object.entries(byProperty).map(([property, p]) => ({
        property, ...p, ctr: p.impressions ? p.clicks / p.impressions : 0,
      })).sort((x, y) => y.ctr - x.ctr),
      detail,
    };
  }

  /**
   * In-house promo impression/click mirror (the GA pipeline turned out to be
   * unreadable for a year; never again). Public, gateway-rate-limited,
   * fire-and-forget from the client.
   *
   * @private
   * @memberof GameService
   */
  private async promoEvent(ctx: Context<{ type: string; property: string; variant: string; placement: string }>) {
    const db = (this.adapter as any) && (this.adapter as any).db;
    if (!db) {
      throw new Errors.MoleculerError('Storage unavailable', 500, 'NO_DB');
    }
    await db.collection('promo_events').insertOne({
      ts: Date.now(),
      type: ctx.params.type,
      property: ctx.params.property,
      variant: ctx.params.variant,
      placement: ctx.params.placement,
    });
    return { ok: true };
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

    const [users, live, activity, games, reasoning, leaderboard, recentRounds, styles, cards, promos] = await Promise.all([
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
      section('styles', () => this.styleStats(db, 2000)),
      section('cards', () => this.cardStats(db, 4000)),
      section('promos', () => this.promoStats(db)),
    ]);

    return { generatedAt: Date.now(), users, live, activity, games, reasoning, leaderboard, recentRounds, styles, cards, promos };
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
    // Two-slot user table from env; slots without both halves set are inert
    const users = [
      { name: process.env.ADMIN_USER, hash: process.env.ADMIN_PASS_SHA256 },
      { name: process.env.ADMIN_USER_2, hash: process.env.ADMIN_PASS_SHA256_2 },
    ].filter(u => u.name && u.hash);
    const key = process.env.ANALYTICS_EXPORT_KEY;

    await new Promise(resolve => setTimeout(resolve, 400));

    const fail = () => { throw new Errors.MoleculerError('Nope.', 401, 'BAD_LOGIN'); };
    if (!users.length || !key) {
      fail();
    }
    const match = users.find(u => u.name === ctx.params.username);
    // Compare against a dummy hash on unknown usernames to keep timing flat
    const target = match ? match.hash : createHash('sha256').update('decoy').digest('hex');
    const given = createHash('sha256').update(ctx.params.password).digest('hex');
    const a = Buffer.from(given);
    const b = Buffer.from(target);
    const passOk = a.length === b.length && timingSafeEqual(a, b);
    if (!match || !passOk) {
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
