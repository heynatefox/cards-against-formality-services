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

  constructor(protected broker: ServiceBroker, protected logger: LoggerInstance) {

  }

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

  private getRandomIndex(upperLimit: number): number {
    return Math.round(Math.random() * upperLimit);
  }

  private pickCzar(turns: TurnDataWithState[], players: { [id: string]: GamePlayer }): string {
    // get the previous rounds czar.
    const turnsLength = turns.length;
    let prevCzar;
    if (turnsLength) {
      const prevTurn = turns[turnsLength - 1];
      prevCzar = prevTurn.czar;
    }

    // pick czar and emit update.
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

  private pickBlackCard(blackCards: string[]): Promise<Card> {
    const index = this.getRandomIndex(blackCards.length - 1);
    // Remove the card so it cannot be chosen again.
    blackCards.splice(index, 1);
    const id = blackCards[index];
    return this.broker.call('cards.get', { id });
  }

  private pickWhiteCard(whiteCards: string[]): string {
    const index = this.getRandomIndex(whiteCards.length - 1);
    // Remove the card so it cannot be chosen again.
    whiteCards.splice(index, 1);
    return whiteCards[index];
  }

  private emitCardsToPlayer(player: GamePlayer) {
    // Get all the cards and deal them to the player.
    return this.broker.call('cards.get', { id: player.cards })
      .then(cards => this.broker.emit('games.deal', { clientId: player._id, cards }));
  }

  // Given a player, deal all the white cards to it.
  protected dealWhiteCards(player: GamePlayer, whiteCards: string[]): Promise<void> {
    const cardsNeeded = 10 - player.cards.length;
    if (!cardsNeeded) {
      return this.emitCardsToPlayer(player);
    }

    while (player.cards?.length !== 10) {
      player.cards.push(this.pickWhiteCard(whiteCards));
    }

    return this.emitCardsToPlayer(player);
  }

  private async ensurePlayersHaveCards(players: { [id: string]: GamePlayer }, whiteCards: string[]) {
    const cardPlayers = Object.values(players).map(player => this.dealWhiteCards(player, whiteCards));
    return Promise.all(cardPlayers);
  }

  protected async startTurn(game: GameInterface): Promise<TurnDataWithState> {
    const { turnData, players, room, turns, whiteCards, blackCards } = game;
    // mutate by reference. ensure we reset the czar.
    Object.values(players).forEach(player => player.isCzar = false);

    turnData.turn += 1;
    // players mutated by reference.
    turnData.czar = this.pickCzar(turns, players);
    // mutate black and white cards by reference
    turnData.blackCard = await this.pickBlackCard(blackCards);
    await this.ensurePlayersHaveCards(players, whiteCards);

    // tslint:disable-next-line: max-line-length
    await this.broker.call('games.update', { id: game._id, selectedCards: {}, players, whiteCards, blackCards, turnData });
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

  protected async submitCards(game: GameInterface, clientId: string, cards: string[]): Promise<GameInterface> {
    const { selectedCards, turnData, players } = game;

    if (turnData.czar === clientId) {
      throw new Error('The czar is not allowed to play the round.');
    }
    if (clientId in selectedCards) {
      throw new Error('You have already submitted your cards.');
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
    // NOT CONFIDENT THAT THIS WILL WORK. DOUBLE CHECK
    await this.broker.call('games.update', {
      id: game._id, [playersProp]: newCards, [selectedCardsProp]: cards
    });
    return this.broker.call('games.get', { id: game._id, populate: ['room'] });
  }

  protected selectWinner(selectedCards: { [id: string]: string[] }, winner: string): Promise<Card[]> {
    const winningCards = selectedCards[winner];
    return this.broker.call('cards.get', { id: winningCards });
  }

  protected async populatedSelectedCards(selectedCards: { [id: string]: string[] }) {
    const allSelectedCards = Object.values(selectedCards).flat(1);
    const cards: Card[] = await this.broker.call('cards.get', { id: allSelectedCards });
    const entries = Object.entries(selectedCards).map(([key, value]) => {
      const populatedCards = value.map(v => cards.find(c => c._id === v));
      return [key, populatedCards];
    });
    return Object.fromEntries(entries);
  }

  protected hasEveryoneSelected(game: GameInterface): boolean {
    const { players, selectedCards, turnData } = game;
    // ensure every player, has a property in the selected cards map.
    return Object.keys(players).every(player => {
      return player in selectedCards || turnData.czar === player;
    });
  }
}
