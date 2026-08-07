import { ServiceBroker, LoggerInstance } from 'moleculer';

import TurnHandler, { GameState, TurnDataWithState, TurnData } from './turn';
import { PROBE_BOT_IDS, isProbeBot, updateProfile, Axis } from './solo-probe';
import { POINTS_WIN, POINTS_PREDICT, REBOOT_COST, pointsTarget } from './economy';

// turn-setup -> playing cards -> selecting winner -> repeat. -> end-game.
/**
 * Status is an enumerated value to indicate the status of the room.
 *
 * @enum {number}
 */
enum Status {
  PENDING = 'status',
  STARTED = 'started',
  FINISHED = 'finished'
}

/**
 * Room Options is an interface that represents the options in a room object.
 *
 * @interface RoomOptions
 */
interface RoomOptions {
  decks: string[];
  target: number;
  maxPlayers: number;
  roundTime: number;
  randoCardrissian?: boolean;
}

// Virtual house-rule player. The frontend maps this id to "Rando Cardrissian".
export const RANDO_ID = 'rando-cardrissian';

/**
 * Room is an interface dictates the shape of the Room.
 *
 * @interface Room
 */
export interface Room {
  _id: string;
  host: string;
  players: string[];
  spectators: string[];
  name: string;
  status: Status;
  options: RoomOptions;
  passcode?: string;
}

export interface GamePlayer {
  _id: string;
  score: number;
  isCzar: boolean;
  cards?: string[];
}

export interface GameInterface {
  _id: string;
  roundTime: number;
  room: Room;
  players: { [id: string]: GamePlayer };
  gameState: GameState;
  prevTurnData: TurnDataWithState;
  turns: TurnDataWithState[];
  whiteCards: string[];
  blackCards: string[];
  turnData: TurnData;
  selectedCards: { [id: string]: string[] };
}

export default class Game extends TurnHandler {

  private gameTimeout: { [gameId: string]: NodeJS.Timer } = {};

  constructor(broker: ServiceBroker, logger: LoggerInstance) {
    super(broker, logger);
  }

  // When each game's timer was armed, for how long, and for WHICH state/turn.
  // The state and turn let a firing timer prove it is still current: if the
  // doc has moved on since arming, the timer is stale and must not advance
  // the game a second time.
  private timeoutMeta: { [gameId: string]: { armedAt: number; timeoutSecs: number; state?: string; turn?: number } } = {};

  // One phase advance at a time per game. The timer callback, the watchdog
  // and Rando all read-modify-write the same document; unserialised, two of
  // them interleave and the round replays or double-advances. This is an
  // in-process lock and assumes a single games-service instance, which is
  // the current deployment shape.
  private gameLocks: { [gameId: string]: Promise<void> } = {};

  public withGameLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.gameLocks[gameId] || Promise.resolve();
    const run = prev.then(fn, fn);
    this.gameLocks[gameId] = run.then(() => undefined, () => undefined);
    return run;
  }

  private setGameTimeout(gameId: string, cb: (game: GameInterface) => void, timeout: number, armedFor?: { state: string; turn: number }) {
    if (this.gameTimeout[gameId]) {
      clearTimeout(this.gameTimeout[gameId]);
    }

    this.timeoutMeta[gameId] = { armedAt: Date.now(), timeoutSecs: timeout, state: armedFor && armedFor.state, turn: armedFor && armedFor.turn };
    this.gameTimeout[gameId] = setTimeout(() => this.withGameLock(gameId, async () => {
      // Timing only. This fetch pulls the whole game doc, which grows with the
      // match: 160 turns measured at 147KB. If the between-rounds delay people
      // report is transport rather than logic, it shows up right here.
      const t0 = Date.now();
      try {
        const game = await this.broker.call<GameInterface, any>('games.get', { id: gameId, populate: ['room'] });
        // Staleness guard: if the doc has moved past the state/turn this timer
        // was armed for, something else already advanced the game (an early
        // all-submitted advance, the czar picking, another instance during a
        // rolling deploy). Firing anyway is exactly the round-replay bug.
        const meta = this.timeoutMeta[gameId];
        if (meta && meta.state && game && game.turnData) {
          const sameState = (game as any).gameState === meta.state;
          const sameTurn = game.turnData.turn === meta.turn;
          if (!sameState || !sameTurn) {
            this.logger.warn(`skip stale timer ${gameId}: armed for ${meta.state}/t${meta.turn}, doc is ${(game as any).gameState}/t${game.turnData.turn}`);
            return;
          }
        }
        const tGet = Date.now();
        await cb(game);
        const tCb = Date.now();
        if (tCb - t0 > 1500) {
          this.logger.warn(`slow phase advance ${gameId}: get=${tGet - t0}ms handler=${tCb - tGet}ms armedFor=${timeout}s`);
        }
      } catch (err) {
        this.logger.warn(`Game timeout handler error (gameId: ${gameId}): ${err.message}`);
      }
    }), timeout * 1000);
  }

  public destroyGame(id: string) {
    if (this.gameTimeout[id]) {
      clearTimeout(this.gameTimeout[id]);
      delete this.gameTimeout[id];
    }
    delete this.timeoutMeta[id];
    return this.broker.call('games.remove', { id });
  }

  /**
   * Watchdog: every game doc whose phase deadline has long passed without a
   * state change gets its timer re-armed from persisted state. Heals games
   * orphaned by deploys/restarts (timers live in process memory) and by
   * timer callbacks that died. onTurnUpdated re-persists the same state and
   * re-arms the correct phase timer, so play resumes where it stalled.
   *
   * @public
   * @param {GameInterface[]} games  all game docs (unpopulated is fine)
   * @memberof Game
   */
  public async resumeStalledGames(games: GameInterface[]) {
    // 10s of slack, not 30. The grace exists to avoid resuming a phase that
    // is merely finishing; measured phase advances complete in well under a
    // second, so 30 was three times longer than anything it protected and
    // every second of it was a player staring at a frozen screen.
    const GRACE_MS = 10 * 1000;
    for (const game of games) {
      // A live in-process timer that has not expired vouches for the game.
      const meta = this.timeoutMeta[game._id];
      const timerHealthy = meta && Date.now() <= meta.armedAt + meta.timeoutSecs * 1000 + GRACE_MS;
      if (timerHealthy) {
        continue;
      }

      // No healthy timer in THIS process. That used to mean "stalled", which
      // was the round-replay bug: every deploy wipes process memory, so the
      // boot sweep resumed every live game, re-announced the round players
      // were mid-way through with the same black card, and locked out anyone
      // who had already submitted. The document itself now says when the state
      // last changed, so a game is only stalled once its own phase deadline
      // has genuinely passed.
      const stateAge = Date.now() - ((game as any).stateChangedAt || 0);
      const phase = String((game as any).gameState || '');
      const phaseSecs = phase === GameState.TURN_SETUP ? 10 : ((game as any).roundTime || 60);
      if (stateAge < phaseSecs * 1000 + GRACE_MS) {
        // Healthy game, dead timer (fresh boot). Re-arm quietly for the time
        // it has left instead of replaying the announcement.
        const leftSecs = Math.max(1, Math.ceil(phaseSecs - stateAge / 1000));
        const prevT = (game as any).prevTurnData;
        if (prevT && prevT.gameId) {
          this.logger.info(`watchdog: re-arming live game ${game._id} (${phase}, ${leftSecs}s left)`);
          const armedFor = { state: phase, turn: game.turnData && game.turnData.turn };
          if (phase === GameState.TURN_SETUP) {
            this.setGameTimeout(game._id, (g) => this.handleNextTurn(g), leftSecs, armedFor);
          } else if (phase === GameState.PICKING_CARDS) {
            this.setGameTimeout(game._id, (g) => this.handleWinnerSelection(g), leftSecs, armedFor);
          } else if (phase === GameState.SELECTING_WINNER) {
            this.setGameTimeout(game._id, (g) => this.handleNoWinner(g, 'The Czar did not pick a winner! They have failed us all...'), leftSecs, armedFor);
          } else {
            this.setGameTimeout(game._id, (g) => { this.destroyGame(g._id); }, leftSecs, armedFor);
          }
        }
        continue;
      }

      // A stalled game only deserves resurrection if its room still exists.
      // Thousands of orphaned game docs accumulated from rooms that died
      // without firing rooms.removed; those get destroyed, not resumed.
      const roomId = typeof (game as any).room === 'string' ? (game as any).room : (game as any).room && (game as any).room._id;
      const room = roomId
        ? await this.broker.call('rooms.get', { id: roomId }).catch(() => null)
        : null;
      if (!room) {
        this.logger.info(`watchdog: destroying orphaned game ${game._id} (room gone)`);
        await this.destroyGame(game._id).catch(err => this.logger.warn(`watchdog: destroy failed ${game._id}: ${err.message}`));
        continue;
      }
      // Rooms with nobody in them don't need their game running either
      if (!((room as any).players || []).length) {
        this.logger.info(`watchdog: destroying game ${game._id} (room empty)`);
        await this.destroyGame(game._id).catch(err => this.logger.warn(`watchdog: destroy failed ${game._id}: ${err.message}`));
        continue;
      }

      const prev = (game as any).prevTurnData;
      if (!prev || !prev.gameId) {
        // Too fresh to have a persisted turn; leave it for the next sweep
        continue;
      }
      this.logger.warn(`watchdog: resuming stalled game ${game._id} (state: ${(game as any).gameState}, stateAge=${Math.round(stateAge / 1000)}s)`);
      try {
        await this.withGameLock(game._id, () => this.onTurnUpdated(prev));
      } catch (err) {
        this.logger.warn(`watchdog: failed to resume ${game._id}: ${err.message}`);
      }
    }
  }

  public async onTurnUpdated(updatedTurn: TurnDataWithState) {
    // Submission-progress pings are display only. They must never reach the
    // state machine: this handler stamps stateChangedAt and re-arms the phase
    // timer, so treating a ping as a real transition would reset the round
    // clock on every submit (an endless picking phase), overwrite prevTurnData
    // with a payload carrying winner:null, and re-schedule Rando each time.
    if ((updatedTurn as any)?.progressOnly) { return; }
    try {
      // Try update the games prevState.
      // tslint:disable-next-line: max-line-length
      // stateChangedAt lets the watchdog judge staleness from the document
      // rather than from process memory that a deploy wipes.
      const updatedGame: GameInterface = await this.broker.call('games.update', { id: updatedTurn.gameId, prevTurnData: updatedTurn, gameState: updatedTurn.state, stateChangedAt: Date.now() });

      const armedFor = { state: updatedTurn.state, turn: updatedTurn.turn };
      switch (updatedTurn.state) {
        case GameState.TURN_SETUP:
          const timeout = updatedGame.prevTurnData.initializing ? 0 : 10;
          return this.setGameTimeout(updatedTurn.gameId, (game) => this.handleNextTurn(game), timeout, armedFor);
        case GameState.PICKING_CARDS:
          this.scheduleRandoPlay(updatedTurn.gameId);
          if ((updatedGame as any).soloMode) { this.scheduleProbePlay(updatedTurn.gameId); }
          return this.setGameTimeout(updatedTurn.gameId, (game) =>
            this.handleWinnerSelection(game), updatedGame.roundTime, armedFor);
        case GameState.SELECTING_WINNER:
          return this.setGameTimeout(updatedTurn.gameId, (game) => this.handleNoWinner(game, 'The Czar did not pick a winner! They have failed us all...'), updatedGame.roundTime, armedFor);
        case GameState.ENEDED:
          return this.setGameTimeout(updatedTurn.gameId, (game) => {
            // kick everyone out and end the game;
            this.destroyGame(game._id);
          }, updatedGame.roundTime, armedFor);
        default:
          this.logger.error('Not sure which state to call');
          return;
      }
    } catch (e) {
      // This block wraps BOTH the state write and the timer arming, so a failed
      // write used to leave the game with no timer at all: dead until the
      // watchdog noticed, up to a minute and a half later. Log it properly
      // (logger.warn on a raw error object printed nothing greppable, which is
      // why this never showed up) and arm a short recovery so the game retries
      // itself in seconds rather than waiting to be rescued.
      const msg = (e && (e as any).message) || String(e);
      this.logger.error(`onTurnUpdated failed for ${updatedTurn && updatedTurn.gameId} (state: ${updatedTurn && updatedTurn.state}): ${msg}`);
      if (updatedTurn && updatedTurn.gameId) {
        this.setGameTimeout(updatedTurn.gameId, (game) => this.handleNextTurn(game), 5);
      }
    }
  }

  private initalizePlayers(room: Room): { [id: string]: GamePlayer } {
    const players = room.players.reduce((acc, curr) => {
      acc[curr] = { _id: curr, cards: [], isCzar: false, score: 0 };
      return acc;
    }, {});
    // House rule: Rando plays too (never czars — see pickCzar in turn.ts)
    if (room.options?.randoCardrissian) {
      players[RANDO_ID] = { _id: RANDO_ID, cards: [], isCzar: false, score: 0 };
    }
    // Solo: probe bots fill the seats. They play cards chosen by the probe
    // engine and never judge, so the single human is czar every round.
    if ((room.options as any)?.soloMode) {
      for (const botId of PROBE_BOT_IDS) {
        players[botId] = { _id: botId, cards: [], isCzar: false, score: 0 };
      }
    }
    return players;
  }

  public onGameStart(room: Room) {
    const players = this.initalizePlayers(room);
    const initalTurnData = {
      czar: null,
      blackCard: null,
      turn: 0
    };
    const initalGameState = GameState.TURN_SETUP;
    const gameData: TurnDataWithState = {
      gameId: '',
      players: Object.values(players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: room._id,
      ...initalTurnData,
      selectedCards: {},
      winner: null,
      winningCards: [],
      state: initalGameState,
      initializing: true
    };

    return this.fetchCards(room.options.decks)
      .then(({ whiteCards, blackCards }) => {
        return this.broker.call('games.create', {
          room: room._id,
          players,
          gameState: initalGameState,
          prevTurnData: initalGameState,
          turns: [],
          whiteCards,
          blackCards,
          turnData: initalTurnData,
          selectedCards: {},
          roundTime: room.options.roundTime,
          predictions: {},
          soloMode: !!(room.options as any)?.soloMode
        });
      })
      .then((game: GameInterface) => {
        gameData.gameId = game._id;
        return this.broker.call<Room, any>('rooms.update', { id: room._id, status: 'started' });
      })
      .then(() => {
        return this.broker.emit('games.turn.updated', gameData);
      })
      .catch(() => {
        this.logger.error('Failed to create game');
      });
  }

  private async endGame(game: GameInterface) {
    if (this.gameTimeout[game._id]) {
      clearTimeout(this.gameTimeout[game._id]);
    }

    this.logger.info('End game triggered');
    const { players, turnData, room } = game;
    // emit end game, with score tally and info.

    let winners = { _ids: [], score: 0 };
    Object.values(players).forEach(({ _id, score }) => {
      // Player has a largest score. Take all the glory!
      if (score > winners.score) {
        winners = { _ids: [_id], score };
        return;
      }

      // Equal score, share the glory!
      if (score === winners.score) {
        winners._ids.push(_id);
      }
    });

    const gameData: TurnDataWithState = {
      gameId: game._id,
      players: Object.values(players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: room._id,
      ...turnData,
      selectedCards: {},
      winner: winners._ids,
      winningCards: [],
      state: GameState.ENEDED,
    };

    await this.broker.emit('games.turn.updated', gameData);
    return this.broker.call<Room, any>('rooms.update', { id: room._id, status: 'finished' })
      .then(() => this.logger.info('Game ended', gameData))
      .catch((err) => { this.logger.error(err); });
  }

  private handleNextTurn(game: GameInterface) {
    if (this.gameTimeout[game._id]) {
      clearTimeout(this.gameTimeout[game._id]);
    }

    const { players, room } = game;
    // Target should actually be based on the first user score to get to that.
    const isTargetReached = Object.values(players).some(player => player.score >= pointsTarget(room.options.target));
    // if not enough cards to continue. End game.
    const hasEnoughCards = this.hasEnoughCards(Object.values(players), game.whiteCards, game.blackCards);
    if (isTargetReached || !hasEnoughCards) {
      this.endGame(game).catch(err => this.logger.error(`endGame error: ${err.message}`));
      return;
    }

    // mutate players by reference
    Object.values(players).forEach(player => player.isCzar = false);
    return this.startTurn(game)
      .then(dataWithState => {
        return this.broker.emit('games.turn.updated', dataWithState);
      })
      .catch(err => {
        this.logger.error(err);
      });
  }

  private async handleWinnerSelection(game: GameInterface) {
    if (this.gameTimeout[game._id]) {
      clearTimeout(this.gameTimeout[game._id]);
    }

    const { selectedCards, players, turnData, room } = game;
    // If no users selected any cards to play, skip.
    if (!Object.keys(selectedCards).length) {
      this.handleNoWinner(game, 'No one selected any cards. Everyone loses!');
      return;
    }

    this.logger.info('Round time up. Entering winner selection stage');
    const populatedSelectedCards = await this.populatedSelectedCards(selectedCards);
    // Send all cards for everyone to view.

    const gameData: TurnDataWithState = {
      gameId: game._id,
      players: Object.values(players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: room._id,
      ...turnData,
      selectedCards: populatedSelectedCards,
      winner: null,
      winningCards: [],
      state: GameState.SELECTING_WINNER,
    };

    await this.broker.emit('games.turn.updated', gameData);
  }

  /**
   * House rule: a few seconds into each picking phase, Rando submits random
   * cards from his hand. Separate timeout map so it never clobbers the round
   * timer. Fire-and-forget; all failures are non-fatal.
   *
   * @private
   * @param {string} gameId
   * @memberof Game
   */
  private randoTimeout: { [gameId: string]: NodeJS.Timer } = {};

  private scheduleRandoPlay(gameId: string) {
    if (this.randoTimeout[gameId]) {
      clearTimeout(this.randoTimeout[gameId]);
    }
    // Randomized 3-8s so Rando feels like a (bad) player, not a cron job
    const delay = 3000 + Math.random() * 5000;
    this.randoTimeout[gameId] = setTimeout(() => this.withGameLock(gameId, async () => {
      try {
        const game = await this.broker.call<GameInterface, any>('games.get', { id: gameId, populate: ['room'] });
        const rando = game?.players?.[RANDO_ID];
        if (!rando || game.gameState !== GameState.PICKING_CARDS || game.selectedCards?.[RANDO_ID]) {
          return;
        }
        const pick = (game.turnData?.blackCard as any)?.pick ?? 1;
        const hand = [...(rando.cards ?? [])];
        if (hand.length < pick) {
          return;
        }
        const chosen: string[] = [];
        for (let i = 0; i < pick; i++) {
          chosen.push(hand.splice(Math.floor(Math.random() * hand.length), 1)[0]);
        }
        await this.onHandSubmitted(game, RANDO_ID, chosen);
      } catch (err) {
        this.logger.warn(`Rando play failed (gameId: ${gameId}): ${err.message}`);
      }
    }), delay);
  }

  // Bot timers per game, one slot like Rando's: re-arming clears the old run.
  private probeTimeout: { [gameId: string]: NodeJS.Timer[] } = {};

  /**
   * Solo: the bots submit their probe-selected cards on a humanised stagger.
   * Each submit re-reads the doc under the game lock and checks state and
   * turn, so a round that advanced early (the czar can pick as soon as all
   * bots are in) is never double-played.
   */
  private scheduleProbePlay(gameId: string) {
    (this.probeTimeout[gameId] || []).forEach(t => clearTimeout(t));
    this.probeTimeout[gameId] = PROBE_BOT_IDS.map((botId, i) => setTimeout(
      () => this.withGameLock(gameId, async () => {
        try {
          const game = await this.broker.call<GameInterface, any>('games.get', { id: gameId, populate: ['room'] });
          const probe = (game as any)?.soloProbe;
          if (!game || game.gameState !== GameState.PICKING_CARDS || !probe || !probe.botCards) { return; }
          if (game.selectedCards?.[botId]) { return; }
          const cardId = probe.botCards[botId];
          if (!cardId) { return; }
          await this.onHandSubmitted(game, botId, [cardId]);
        } catch (err) {
          this.logger.warn(`probe bot play failed (gameId: ${gameId}, bot: ${botId}): ${err.message}`);
        }
      }),
      // 1.6s, 3.4s, 5.2s with jitter: fast enough that a solo round never
      // drags, spaced enough to read as opponents rather than a batch job.
      1600 + i * 1800 + Math.random() * 900,
    ));
  }

  public async onHandSubmitted(game: GameInterface, playerId: string, whiteCards: string[]) {
    const { gameState } = game;
    // Ignore cards if the game state is no longer picking cards.
    if (gameState !== GameState.PICKING_CARDS) {
      throw new Error('Not allowed to select cards at this time');
    }

    const updatedGame = await this.submitCards(game, playerId, whiteCards);

    // Broadcast who has submitted so the "N of M answers in" counter moves.
    // The PICKING payload ships selectedCards:{} and nothing ever refreshed it,
    // so that counter has always read 0 for everyone (there was a TODO on it in
    // turn.ts). Keys only, values deliberately emptied: revealing the actual
    // cards mid-round would let players see each other's plays before judging.
    try {
      const submittedKeys: { [id: string]: any[] } = {};
      Object.keys(updatedGame.selectedCards || {}).forEach(id => { submittedKeys[id] = []; });
      await this.broker.emit('games.turn.updated', {
        gameId: updatedGame._id,
        roomId: (updatedGame.room as any)?._id ?? updatedGame.room,
        players: Object.values(updatedGame.players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
        ...updatedGame.turnData,
        selectedCards: submittedKeys,
        winner: null,
        winningCards: [],
        state: GameState.PICKING_CARDS,
        progressOnly: true,
      });
    } catch (err) {
      this.logger.warn(`submit progress broadcast failed: ${err.message}`);
    }

    if (this.hasEveryoneSelected(updatedGame)) {
      // CONTRACT: the caller holds this game's lock (bot and Rando timers,
      // the timer callback, the watchdog, and the submit action all do).
      // Taking it again here deadlocked the whole game: the chain is a
      // promise queue, not a reentrant mutex, so the inner acquire waited on
      // the outer forever and every later timer queued behind the wedge.
      // The fresh re-read plus state check keeps the transition idempotent
      // when the last two submits race.
      const fresh = await this.broker.call<GameInterface, any>('games.get', { id: game._id, populate: ['room'] }).catch(() => null);
      if (!fresh || (fresh as any).gameState !== GameState.PICKING_CARDS) { return; }
      await this.handleWinnerSelection(fresh);
    }
  }

  private async handleNoWinner(game: GameInterface, reason?: string) {
    if (this.gameTimeout[game._id]) {
      clearTimeout(this.gameTimeout[game._id]);
    }

    const { players, turnData, room, turns } = game;
    const gameData: TurnDataWithState = {
      gameId: game._id,
      players: Object.values(players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: room._id,
      ...turnData,
      selectedCards: {},
      winner: null,
      winningCards: [],
      state: GameState.TURN_SETUP,
      errorMessage: reason?.length ? reason : 'No one selected any cards. Everyone loses!'
    };

    // Store the end state of each round in a collection.
    turns.push(gameData);
    await this.broker.call('games.update', { id: game._id, turns });
    await this.broker.emit('games.turn.updated', gameData);
  }

  public async onWinnerSelected(game: GameInterface, winner: string, clientId: string) {
    if (this.gameTimeout[game._id]) {
      clearTimeout(this.gameTimeout[game._id]);
    }

    const { turnData, gameState, players, turns, room, selectedCards } = game;
    if (clientId !== turnData.czar) {
      throw new Error('Only the czar is allowed to select the winner');
    }

    // Only allow one winning card to be selected.
    if (gameState !== GameState.SELECTING_WINNER) {
      throw new Error('This is not the correct round to select a winner');
    }

    const winningCards = await this.selectWinner(selectedCards, winner);
    // reset selected cards.
    // emit winning cards.
    const winningPlayer = players[winner];
    if (winningPlayer) {
      winningPlayer.score += POINTS_WIN;
    }

    // Audience predictions: everyone who called this winner during the
    // deliberation gets paid. Kept out of any preference field; a prediction
    // is a belief about the judge, not a taste signal.
    const predictions: { [p: string]: string } = (game as any).predictions || {};
    for (const [predictor, predicted] of Object.entries(predictions)) {
      if (predicted === winner && players[predictor]) {
        players[predictor].score += POINTS_PREDICT;
      }
    }
    const populatedSelectedCards = await this.populatedSelectedCards(selectedCards);

    const gameData: TurnDataWithState = {
      gameId: game._id,
      players: Object.values(players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: room._id,
      ...turnData,
      selectedCards: populatedSelectedCards,
      winner: winner,
      winningCards,
      state: GameState.TURN_SETUP,
    };

    // Judge deliberation: SELECTING was announced at stateChangedAt (written
    // by onTurnUpdated), so the gap to now is how long the czar actually
    // deliberated over the revealed cards. The close calls are the slow ones.
    const deliberationMs = (game as any).stateChangedAt
      ? Math.max(0, Date.now() - (game as any).stateChangedAt)
      : null;

    // Store the end state of each round in a collection.
    turns.push(gameData);
    await this.broker.call('games.update', { id: game._id, turns, players, czarDeliberationMs: deliberationMs, lastPredictions: predictions, predictions: {} });

    // Solo: the czar's verdict is the observation. Fold the winning card's
    // value on the probed axis into the player's taste profile, fire and
    // forget: a failed profile write must never block the round.
    const probe = (game as any).soloProbe;
    if ((game as any).soloMode && probe && probe.axis && isProbeBot(winner)) {
      const winnerCardId = probe.botCards && probe.botCards[winner];
      // A control-round win (the seeded dud took the crown) is an attention
      // flag, not a taste observation; it must never move the profile.
      const isControlWin = probe.controlBot && winner === probe.controlBot;
      const tags = winnerCardId && !isControlWin ? this.tagsForCard(winnerCardId) : null;
      if (tags) {
        this.broker.call('games.solo-observe', {
          player: probe.targetPlayer,
          axis: probe.axis,
          tags,
          winnerCard: winnerCardId,
          retest: probe.retest || undefined,
          decisionMs: deliberationMs || undefined,
        }).catch(err => this.logger.warn(`solo-observe failed: ${err.message}`));
      }
    }

    // Emit the winning card, and winning player, for front-end display
    await this.broker.emit('games.turn.updated', gameData);
  }

  public async onPlayerLeave(game: GameInterface, playerId: string, adapter: any, onUpdated: any) {
    const player = game.players[playerId];

    // delete this.players[playerId];
    const prop = `players.${playerId}`;
    const newGameObj = await adapter.updateById(game._id, { $unset: { [prop]: 1 } });
    if (!newGameObj) {
      this.logger.warn(`onPlayerLeave: adapter.updateById returned null for game ${game._id}`);
      return;
    }
    onUpdated(newGameObj);
    newGameObj._id = newGameObj._id.toString();
    // if that was the last player to leave. End the game.
    if (!Object.keys(newGameObj.players).length) {
      this.destroyGame(game._id);
      return;
    }

    newGameObj.room = { _id: newGameObj.room };
    // If the czar leaves the game. End the turn.
    if (player.isCzar) {
      this.handleNoWinner(newGameObj, 'The Czar left the game');
    }

  }

  public async onPlayerJoin(game: GameInterface, playerId: string) {
    let player = game.players[playerId];
    if (!player) {
      // Ensure the new player is included in the match.
      player = { _id: playerId, cards: [], isCzar: false, score: 0 };
      const playersProp = `players.${playerId}`;
      game = await this.broker.call('games.update', { id: game._id, [playersProp]: player });

      // add the new player to the state.
      game.prevTurnData.players.push(player);
    }

    if (game.gameState !== GameState.TURN_SETUP) {
      // This needs to be implemented in a better way... User may not have a registered socekt id yet.
      setTimeout(async () => {
        try {
          // send game state to recently joined user.
          await this.broker.emit('games.turn.updated.client', { clientId: player._id, gameData: game.prevTurnData });

          // if picking cards, ensure the user is delt their cards.
          if (game.gameState === GameState.PICKING_CARDS) {
            await this.dealWhiteCards(player, game.whiteCards);
          }
        } catch (err) {
          this.logger.warn(`onPlayerJoin delayed setup error (playerId: ${player._id}): ${err.message}`);
        }
      }, 2000);
    }
  }

  public destroy() {
    // if (this.gameTimeout) {
    //   clearTimeout(this.gameTimeout);
    // }

    // this.players = {};

    // handle firing game removed update.
  }

  /**
   * House rule "Rebooting the Universe": a player pays one point to discard
   * their hand and draw a fresh one. Validations live in the games-service
   * action; this performs the swap, persists it, and deals the new hand.
   *
   * @public
   * @param {GameInterface} game
   * @param {string} clientId
   * @returns {Promise<{ score: number }>}
   * @memberof Game
   */
  public async rebootPlayerHand(game: GameInterface, clientId: string): Promise<{ score: number }> {
    const player = game.players[clientId];
    player.score -= REBOOT_COST;
    player.cards = [];
    // Mutates player.cards and whiteCards by reference and emits the new hand
    const whiteCards = await this.dealWhiteCards(player, game.whiteCards);
    await this.broker.call('games.update', { id: game._id, players: game.players, whiteCards });
    return { score: player.score };
  }
}
