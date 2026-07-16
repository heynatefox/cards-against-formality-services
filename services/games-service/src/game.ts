import { ServiceBroker, LoggerInstance } from 'moleculer';

import TurnHandler, { GameState, TurnDataWithState, TurnData } from './turn';

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

  // When each game's timer was armed and for how long. The watchdog uses
  // this to spot games whose timer died (process restart, crashed callback)
  // and bring them back to life from the persisted game doc.
  private timeoutMeta: { [gameId: string]: { armedAt: number; timeoutSecs: number } } = {};

  private setGameTimeout(gameId: string, cb: (game: GameInterface) => void, timeout: number) {
    if (this.gameTimeout[gameId]) {
      clearTimeout(this.gameTimeout[gameId]);
    }

    this.timeoutMeta[gameId] = { armedAt: Date.now(), timeoutSecs: timeout };
    this.gameTimeout[gameId] = setTimeout(async () => {
      try {
        const game = await this.broker.call<GameInterface, any>('games.get', { id: gameId, populate: ['room'] });
        await cb(game);
      } catch (err) {
        this.logger.warn(`Game timeout handler error (gameId: ${gameId}): ${err.message}`);
      }
    }, timeout * 1000);
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
    const GRACE_MS = 30 * 1000;
    for (const game of games) {
      const meta = this.timeoutMeta[game._id];
      const stalled = !meta || Date.now() > meta.armedAt + meta.timeoutSecs * 1000 + GRACE_MS;
      if (!stalled) {
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
      this.logger.warn(`watchdog: resuming stalled game ${game._id} (state: ${(game as any).gameState})`);
      try {
        await this.onTurnUpdated(prev);
      } catch (err) {
        this.logger.warn(`watchdog: failed to resume ${game._id}: ${err.message}`);
      }
    }
  }

  public async onTurnUpdated(updatedTurn: TurnDataWithState) {
    try {
      // Try update the games prevState.
      // tslint:disable-next-line: max-line-length
      const updatedGame: GameInterface = await this.broker.call('games.update', { id: updatedTurn.gameId, prevTurnData: updatedTurn, gameState: updatedTurn.state });

      switch (updatedTurn.state) {
        case GameState.TURN_SETUP:
          const timeout = updatedGame.prevTurnData.initializing ? 0 : 10;
          return this.setGameTimeout(updatedTurn.gameId, (game) => this.handleNextTurn(game), timeout);
        case GameState.PICKING_CARDS:
          this.scheduleRandoPlay(updatedTurn.gameId);
          return this.setGameTimeout(updatedTurn.gameId, (game) =>
            this.handleWinnerSelection(game), updatedGame.roundTime);
        case GameState.SELECTING_WINNER:
          return this.setGameTimeout(updatedTurn.gameId, (game) => this.handleNoWinner(game, 'The Czar did not pick a winner! They have failed us all...'), updatedGame.roundTime);
        case GameState.ENEDED:
          return this.setGameTimeout(updatedTurn.gameId, (game) => {
            // kick everyone out and end the game;
            this.destroyGame(game._id);
          }, updatedGame.roundTime);
        default:
          this.logger.error('Not sure which state to call');
          return;
      }
    } catch (e) {
      this.logger.warn(e);
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
          roundTime: room.options.roundTime
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
    const isTargetReached = Object.values(players).some(player => player.score >= room.options.target);
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
    this.randoTimeout[gameId] = setTimeout(async () => {
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
    }, delay);
  }

  public async onHandSubmitted(game: GameInterface, playerId: string, whiteCards: string[]) {
    const { gameState } = game;
    // Ignore cards if the game state is no longer picking cards.
    if (gameState !== GameState.PICKING_CARDS) {
      throw new Error('Not allowed to select cards at this time');
    }

    const updatedGame = await this.submitCards(game, playerId, whiteCards);
    if (this.hasEveryoneSelected(updatedGame)) {
      this.handleWinnerSelection(updatedGame);
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
      winningPlayer.score += 1;
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

    // Store the end state of each round in a collection.
    turns.push(gameData);
    await this.broker.call('games.update', { id: game._id, turns, players });
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
    player.score -= 1;
    player.cards = [];
    // Mutates player.cards and whiteCards by reference and emits the new hand
    const whiteCards = await this.dealWhiteCards(player, game.whiteCards);
    await this.broker.call('games.update', { id: game._id, players: game.players, whiteCards });
    return { score: player.score };
  }
}
