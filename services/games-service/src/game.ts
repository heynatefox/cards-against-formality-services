import { ServiceBroker, LoggerInstance } from 'moleculer';

import TurnHandler, { GameState, TurnDataWithState } from './turn';

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

export default class Game extends TurnHandler {

  private gameTimeout: NodeJS.Timer = null;
  private players: { [id: string]: GamePlayer } = this.initalizePlayers(this._room);
  private gameState = GameState.TURN_SETUP;
  protected lastGameState = null;

  constructor(private _room: Room, broker: ServiceBroker, logger: LoggerInstance) {
    super(broker, logger);

    this.onGameStart();
  }

  get room() {
    return this._room;
  }

  private onGameStart() {

    const gameData: TurnDataWithState = {
      players: Object.values(this.players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: this.room._id,
      ...this.turnData,
      selectedCards: {},
      winner: null,
      winningCards: [],
      state: this.gameState,
    };

    return this.fetchCards(this._room.options.decks)
      .then(() => {
        this.logger.info('Game started, sending data', gameData);
        this.lastGameState = gameData;
        this.broker.emit('games.updated', gameData);
        this.handleNextTurn();
      });
  }

  private initalizePlayers(room: Room): { [id: string]: GamePlayer } {
    return room.players.reduce((acc, curr) => {
      acc[curr] = { _id: curr, cards: [], isCzar: false, score: 0 };
      return acc;
    }, {});
  }

  private async endGame() {
    // emit end game, with score tally and info.
    this.gameState = GameState.ENEDED;

    let winners = { _ids: [], score: 0 };
    Object.values(this.players).forEach(({ _id, score }) => {
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
      players: Object.values(this.players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: this.room._id,
      ...this.turnData,
      selectedCards: {},
      winner: winners._ids,
      winningCards: [],
      state: GameState.ENEDED,
    };

    this.lastGameState = gameData;
    await this.broker.emit('games.updated', gameData);
    return this.broker.call<Room, any>('rooms.update', { id: this.room._id, status: 'finished' })
      .then(() => this.logger.info('Game ended', gameData))
      .catch((err) => { this.logger.error(err); });
  }

  private setGameTimeout(cb: () => void, timeout: number = 60 * 1000) {
    if (this.gameTimeout) {
      clearTimeout(this.gameTimeout);
    }

    this.gameTimeout = setTimeout(() => {
      cb();
    }, timeout);
  }

  private handleNextTurn() {
    if (this.gameTimeout) {
      clearTimeout(this.gameTimeout);
    }

    // Target should actually be based on the first user score to get to that.
    const isTargetReached = Object.values(this.players).some(player => player.score >= this._room.options.target);
    if (isTargetReached) {
      this.endGame();
      return;
    }

    return this.startTurn(this.players)
      .then(async data => {
        this.gameState = GameState.PICKING_CARDS;

        const withState: TurnDataWithState = {
          players: Object.values(this.players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
          roomId: this.room._id,
          selectedCards: {},
          winner: null,
          winningCards: [],
          ...data,
          state: GameState.PICKING_CARDS,
        };

        this.logger.info('Starting turn', withState);
        this.lastGameState = withState;
        await this.broker.emit('games.updated', withState);

        this.setGameTimeout(() => this.handleWinnerSelection());
      })
      .catch(err => {
        this.logger.error(err);
      });
  }

  private async handleWinnerSelection() {
    if (this.gameTimeout) {
      clearTimeout(this.gameTimeout);
    }

    // If no users selected any cards to play, skip.
    if (!Object.keys(this.selectedCards).length) {
      this.handleNoWinner('No one selected any cards. Everyone loses!');
      return;
    }

    this.logger.info('Round time up. Entering winner selection stage');
    const populatedSelectedCards = await this.populatedSelectedCards();
    // Send all cards for everyone to view.

    this.gameState = GameState.SELECTING_WINNER;
    const gameData: TurnDataWithState = {
      players: Object.values(this.players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: this.room._id,
      ...this.turnData,
      selectedCards: populatedSelectedCards,
      winner: null,
      winningCards: [],
      state: GameState.SELECTING_WINNER,
    };

    this.lastGameState = gameData;
    await this.broker.emit('games.updated', gameData);

    // If the czar doesn't pick a winner within 60 seconds. Move on.
    this.setGameTimeout(() => this.handleNoWinner('The Czar did not pick a winner! They have failed us all...'));
  }

  public onHandSubmitted(playerId: string, whiteCards: string[]) {
    // Ignore cards if the game state is no longer picking cards.
    if (this.gameState !== GameState.PICKING_CARDS) {
      throw new Error('Not allowed to select cards at this time');
    }

    this.submitCards(playerId, whiteCards);
    // TODO: emit placement 'card selected' for each selection to display on the front-end.
    const playersCards = this.players[playerId].cards;
    // make a new array of cards, excluding the ones the player just played.
    this.players[playerId].cards = playersCards.filter(card => !whiteCards.includes(card));
    if (this.hasEveryoneSelected(this.players)) {
      this.handleWinnerSelection();
    }
  }

  private async handleNoWinner(reason?: string) {
    if (this.gameTimeout) {
      clearTimeout(this.gameTimeout);
    }

    const gameData: TurnDataWithState = {
      players: Object.values(this.players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: this.room._id,
      ...this.turnData,
      selectedCards: {},
      winner: null,
      winningCards: [],
      state: GameState.TURN_SETUP,
      errorMessage: reason?.length ? reason : 'No one selected any cards. Everyone loses!'
    };

    // Store the end state of each round in a collection.
    this.turns.push(gameData);
    this.lastGameState = gameData;
    await this.broker.emit('games.updated', gameData);
    this.setGameTimeout(() => this.handleNextTurn(), 10000);
  }

  public async onWinnerSelected(winner: string, clientId: string) {
    if (this.gameTimeout) {
      clearTimeout(this.gameTimeout);
    }

    if (clientId !== this.turnData.czar) {
      throw new Error('Only the czar is allowed to select the winner');
    }

    // Only allow one winning card to be selected.
    if (this.gameState !== GameState.SELECTING_WINNER) {
      throw new Error('This is not the correct round to select a winner');
    }

    const winningCards = await this.selectWinner(winner);
    // emit winning cards.
    this.players[winner].score += 1;
    this.gameState = GameState.TURN_SETUP;
    const populatedSelectedCards = await this.populatedSelectedCards();

    // This object should be stored in a turns array in the db, for history functionality.
    const gameData: TurnDataWithState = {
      players: Object.values(this.players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: this.room._id,
      ...this.turnData,
      selectedCards: populatedSelectedCards,
      winner: winner,
      winningCards,
      state: GameState.TURN_SETUP,
    };

    // Store the end state of each round in a collection.
    this.turns.push(gameData);
    this.lastGameState = gameData;
    // Emit the winning card, and winning player, for front-end display
    await this.broker.emit('games.updated', gameData);

    this.setGameTimeout(() => this.handleNextTurn(), 10000);
  }

  public onPlayerLeave(playerId: string) {
    const player = this.players[playerId];
    delete this.players[playerId];

    if (!Object.keys(this.players).length) {
      this.endGame();
      return;
    }

    // If the czar leaves the game. End the turn.
    if (player.isCzar) {
      clearTimeout(this.gameTimeout);
      this.handleNoWinner('The Czar left the game');
    }

  }

  public async onPlayerJoin(playerId: string) {
    // Ensure the new player is including in the match.
    this.players[playerId] = { _id: playerId, cards: [], isCzar: false, score: 0 };
    await this.dealWhiteCards(this.players[playerId]);

    // Implement this.
    // if (this.lastGameState) {
    // emit update to only the player that joined.
    // }
  }

  public destroy() {
    if (this.gameTimeout) {
      clearTimeout(this.gameTimeout);
    }

    this.players = {};

    // handle firing game removed update.
  }
}
