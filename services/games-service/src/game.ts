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
}

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

  private setGameTimeout(gameId: string, cb: (game: GameInterface) => void, timeout: number) {
    if (this.gameTimeout[gameId]) {
      clearTimeout(this.gameTimeout[gameId]);
    }

    this.gameTimeout[gameId] = setTimeout(async () => {
      const game = await this.broker.call<GameInterface, any>('games.get', { id: gameId, populate: ['room'] });
      cb(game);
    }, timeout * 1000);
  }

  public destroyGame(id: string) {
    return this.broker.call('games.remove', { id });
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
      this.logger.error(e);
    }
  }

  private initalizePlayers(room: Room): { [id: string]: GamePlayer } {
    return room.players.reduce((acc, curr) => {
      acc[curr] = { _id: curr, cards: [], isCzar: false, score: 0 };
      return acc;
    }, {});
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
      .catch(err => {
        this.logger.error(err);
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
    if (isTargetReached) {
      this.endGame(game);
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
    if (playerId in game.players) {
      // player is already in the game, must've the refreshed page.
      return null;
    }

    // Ensure the new player is included in the match.
    const newPlayer = { _id: playerId, cards: [], isCzar: false, score: 0 };
    const playersProp = `players.${playerId}`;
    return this.broker.call('games.update', { id: game._id, [playersProp]: newPlayer });

    // Implement this.
    // if (this.lastGameState) {
    // emit update to only the player that joined.
    // await this.dealWhiteCards(newPlayer, game.whiteCards);
    // }
  }

  public destroy() {
    // if (this.gameTimeout) {
    //   clearTimeout(this.gameTimeout);
    // }

    // this.players = {};

    // handle firing game removed update.
  }
}
