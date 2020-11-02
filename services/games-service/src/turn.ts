import { GamePlayer, GameInterface } from './game';
import { ServiceBroker, LoggerInstance } from 'moleculer';

export interface Card {
  _id: string;
  text: string;
  cardType: 'white' | 'black';
  pick?: number;
}

export enum GameState {
  TURN_SETUP = 'turnSetup',
  PICKING_CARDS = 'pickingCards',
  SELECTING_WINNER = 'selectingWinner',
  ENEDED = 'ended'
}

export interface TurnData {
  czar: string;
  blackCard: Card;
  turn: number;
  selectedCards: { [id: string]: Card[] };
}

export interface TurnDataWithState extends TurnData {
  gameId: string;
  state: GameState;
  players: GamePlayer[];
  roomId: string;
  winner: string | string[];
  winningCards: Card[];
  errorMessage?: string;
  initializing?: boolean;
}

export default class TurnHandler {

  constructor(protected broker: ServiceBroker, protected logger: LoggerInstance) { }

  /**
   * Given a list of deck ids. Return all white and black cards associated to the decks.
   *
   * @protected
   * @param {string[]} deckIds
   * @returns {Promise<{ whiteCards: string[]; blackCards: string[] }>}
   * @memberof TurnHandler
   */
  protected fetchCards(deckIds: string[]): Promise<{ whiteCards: string[]; blackCards: string[] }> {
    const _whiteCards = [];
    const _blackCards = [];
    return this.broker.call<Array<{ whiteCards: string[]; blackCards: string[] }>, any>('decks.get', { id: deckIds })
      .then(decks => {
        decks.forEach(deck => {
          const { whiteCards, blackCards } = deck;
          _whiteCards.push(...whiteCards);
          _blackCards.push(...blackCards);
        });
        return { whiteCards: _whiteCards, blackCards: _blackCards };
      });
  }

  /**
   * Return a random number between 0 and the upperlimit.
   *
   * @private
   * @param {number} upperLimit
   * @returns {number}
   * @memberof TurnHandler
   */
  private getRandomIndex(upperLimit: number): number {
    return Math.round(Math.random() * upperLimit);
  }

  /**
   * Given a list of players choose the next czar. Mutates player by reference.
   *
   * @private
   * @param {TurnDataWithState[]} turns
   * @param {{ [id: string]: GamePlayer }} players
   * @returns {string}
   * @memberof TurnHandler
   */
  private pickCzar(turns: TurnDataWithState[], players: { [id: string]: GamePlayer }): string {
    // get the previous rounds czar.
    const turnsLength = turns.length;
    let prevCzar;
    if (turnsLength) {
      const prevTurn = turns[turnsLength - 1];
      prevCzar = prevTurn.czar;
    }

    // pick czar
    const playersArr = Object.values(players);
    let selectedPlayer;
    if (!prevCzar) {
      selectedPlayer = playersArr[0];
    } else {
      const indexOfLastCzar = playersArr.findIndex(player => player._id === prevCzar);
      const indexOfNewCzar = indexOfLastCzar + 1;

      // If the array has overspilled. We're back at the start.
      if (indexOfNewCzar > (playersArr.length - 1)) {
        selectedPlayer = playersArr[0];
      } else {
        selectedPlayer = playersArr[indexOfNewCzar];
      }
    }
    // mutate by reference.
    selectedPlayer.isCzar = true;
    return selectedPlayer._id;
  }

  /**
   * Given a set of black cards, Return a random black card.
   *
   * @private
   * @param {string[]} blackCards
   * @returns {Promise<Card>}
   * @memberof TurnHandler
   */
  private pickBlackCard(blackCards: string[]): Promise<Card> {
    const index = this.getRandomIndex(blackCards.length - 1);
    const id = blackCards[index];
    // Remove the card so it cannot be chosen again.
    blackCards.splice(index, 1);
    return this.broker.call('cards.get', { id });
  }

  /**
   * Givn a set of white cards, return a random white card.
   *
   * @private
   * @param {string[]} whiteCards
   * @returns {string}
   * @memberof TurnHandler
   */
  private pickWhiteCard(whiteCards: string[]): string {
    const index = this.getRandomIndex(whiteCards.length - 1);
    const id = whiteCards[index];
    // Remove the card so it cannot be chosen again.
    whiteCards.splice(index, 1);
    return id;
  }

  /**
   * Given a Player, fetch their cards and emit all their cards to them.
   *
   * @private
   * @param {GamePlayer} player
   * @returns
   * @memberof TurnHandler
   */
  private emitCardsToPlayer(player: GamePlayer) {
    // Get all the cards and deal them to the player.
    return this.broker.call('cards.get', { id: player.cards })
      .then(cards => this.broker.emit('games.deal', { clientId: player._id, cards }));
  }

  /**
   * Deal white cards to a Player until they have 10 cards.
   *
   * @protected
   * @param {GamePlayer} player
   * @param {string[]} whiteCards
   * @returns {Promise<string[]>}
   * @memberof TurnHandler
   */
  protected async dealWhiteCards(player: GamePlayer, whiteCards: string[]): Promise<string[]> {
    const cardsNeeded = 10 - player.cards.length;
    if (!cardsNeeded) {
      await this.emitCardsToPlayer(player);
      return whiteCards;
    }

    while (player.cards?.length !== 10) {
      player.cards.push(this.pickWhiteCard(whiteCards));
    }

    await this.emitCardsToPlayer(player);
    return whiteCards;
  }

  /**
   * Ensure each Player has the correct amount of cards for the turn.
   *
   * @private
   * @param {{ [id: string]: GamePlayer }} players
   * @param {string[]} whiteCards
   * @returns
   * @memberof TurnHandler
   */
  private async ensurePlayersHaveCards(players: { [id: string]: GamePlayer }, whiteCards: string[]) {
    for (const player of Object.values(players)) {
      whiteCards = await this.dealWhiteCards(player, whiteCards);
    }

    return whiteCards;
  }

  /**
   * Calculate whether there are enough cards left to proceed based upon the number of players.
   *
   * @param {GamePlayer[]} players
   * @param {string[]} whiteCards
   * @param {string[]} blackCards
   * @returns {boolean}
   * @memberof TurnHandler
   */
  public hasEnoughCards(players: GamePlayer[], whiteCards: string[], blackCards: string[]): boolean {
    // check if there are enough cards left to play the turn.
    const whiteCardsRequired = Object.values(players).reduce((totalRequired, player) => {
      const cardsRequired = 10 - player.cards.length;
      return totalRequired + cardsRequired;
    }, 0);

    return whiteCardsRequired < whiteCards.length && !!blackCards.length;
  }

  /**
   * Given the game state, prepare the game for the start of the turn.
   *
   * @protected
   * @param {GameInterface} game
   * @returns {Promise<TurnDataWithState>}
   * @memberof TurnHandler
   */
  protected async startTurn(game: GameInterface): Promise<TurnDataWithState> {
    const { turnData, players, room, turns, whiteCards, blackCards } = game;

    // mutate by reference. ensure we reset the czar.
    Object.values(players).forEach(player => player.isCzar = false);

    turnData.turn += 1;
    // players mutated by reference.
    turnData.czar = this.pickCzar(turns, players);
    // mutate black and white cards by reference
    turnData.blackCard = await this.pickBlackCard(blackCards);
    const newWhiteCards = await this.ensurePlayersHaveCards(players, whiteCards);

    // tslint:disable-next-line: max-line-length
    await this.broker.call('games.update', { id: game._id, selectedCards: {}, players, whiteCards: newWhiteCards, blackCards, turnData });
    return {
      gameId: game._id,
      players: Object.values(players).map(({ _id, score, isCzar }) => ({ _id, score, isCzar })),
      roomId: room._id,
      selectedCards: {},
      winner: null,
      winningCards: [],
      ...turnData,
      state: GameState.PICKING_CARDS,
    };
  }

  /**
   * Set the Players selected cards for the round.
   *
   * @protected
   * @param {GameInterface} game
   * @param {string} clientId
   * @param {string[]} cards
   * @returns {Promise<GameInterface>}
   * @memberof TurnHandler
   */
  protected async submitCards(game: GameInterface, clientId: string, cards: string[]): Promise<GameInterface> {
    const { selectedCards, turnData, players } = game;

    if (turnData.czar === clientId) {
      throw new Error('The czar is not allowed to play the round.');
    }
    if (clientId in selectedCards) {
      return this.broker.call('games.get', { id: game._id, populate: ['room'] });
    }

    if (turnData.blackCard.pick !== cards.length) {
      throw new Error(`You must select exactly ${turnData.blackCard.pick} cards.`);
    }
    // TODO: emit placement 'card selected' for each selection to display on the front-end.
    const playersCards = players[clientId].cards;
    // make a new array of cards, excluding the ones the player just played.
    const newCards = playersCards.filter(card => !cards.includes(card));

    const playersProp = `players.${clientId}.cards`;
    const selectedCardsProp = `selectedCards.${clientId}`;

    await this.broker.call('games.update', {
      id: game._id, [playersProp]: newCards, [selectedCardsProp]: cards
    });
    return this.broker.call('games.get', { id: game._id, populate: ['room'] });
  }

  /**
   * Fetch the winning cards. Based on the winner.
   *
   * @protected
   * @param {{ [id: string]: string[] }} selectedCards
   * @param {string} winner
   * @returns {Promise<Card[]>}
   * @memberof TurnHandler
   */
  protected selectWinner(selectedCards: { [id: string]: string[] }, winner: string): Promise<Card[]> {
    const winningCards = selectedCards[winner];
    return this.broker.call('cards.get', { id: winningCards })
      .then((cards: Card[]) => {
        // ensure the cards are in the correct order.
        return winningCards.map(id => cards.find(card => card._id === id));
      });
  }

  /**
   * Transform the string ids into Cards.
   *
   * @protected
   * @param {{ [id: string]: string[] }} selectedCards
   * @returns
   * @memberof TurnHandler
   */
  protected async populatedSelectedCards(selectedCards: { [id: string]: string[] }) {
    const allSelectedCards = Object.values(selectedCards).flat(1);
    const cards: Card[] = await this.broker.call('cards.get', { id: allSelectedCards });
    const entries = Object.entries(selectedCards).map(([key, value]) => {
      const populatedCards = value.map(v => cards.find(c => c._id === v));
      return [key, populatedCards];
    });
    return Object.fromEntries(entries);
  }

  /**
   * Returns a boolean determining whether everyone in the round has selected their cards.
   *
   * @protected
   * @param {GameInterface} game
   * @returns {boolean}
   * @memberof TurnHandler
   */
  protected hasEveryoneSelected(game: GameInterface): boolean {
    const { players, selectedCards, turnData } = game;
    // ensure every player, has a property in the selected cards map.
    return Object.keys(players).every(player => {
      return player in selectedCards || turnData.czar === player;
    });
  }
}
