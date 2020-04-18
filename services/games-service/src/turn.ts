import { GamePlayer } from './game';
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
  totalTime: number;
}

export interface TurnDataWithState extends TurnData {
  state: GameState;
  players: GamePlayer[];
  roomId: string;
  selectedCards: { [id: string]: Card[] };
  winner: string | string[];
  winningCards: Card[];
}

export default class TurnHandler {

  private whiteCards: string[] = [];
  private blackCards: string[] = [];
  private _turnData: TurnData = {
    czar: null,
    blackCard: null,
    turn: 0,
    totalTime: 60 * 1000
  };
  public selectedCards: { [id: string]: string[] } = {};

  constructor(protected broker: ServiceBroker, protected logger: LoggerInstance) {

  }

  get turnData() {
    return this._turnData;
  }

  get turn() {
    return this.turnData.turn;
  }

  protected async fetchCards(deckIds: string[]) {
    try {
      // tslint:disable-next-line: max-line-length
      const decks: Array<{ whiteCards: string[]; blackCards: string[] }> = await this.broker.call('decks.get', { id: deckIds });
      decks.forEach(deck => {
        const { whiteCards, blackCards } = deck;
        this.whiteCards.push(...whiteCards);
        this.blackCards.push(...blackCards);
      });
    } catch (e) {
      this.logger.error('Fatal: failed to fetch decks to initialize game');
    }
  }

  private getRandomIndex(upperLimit: number): number {
    return Math.floor(Math.random() * upperLimit);
  }

  private pickCzar(players: { [id: string]: GamePlayer }): string {
    // pick czar and emit update.
    const playersArr = Object.values(players);
    let index = this.getRandomIndex(playersArr.length - 1);
    let selectedPlayer = playersArr[index];
    if (!selectedPlayer) {
      // This should be recurrsive.
      index = this.getRandomIndex(playersArr.length - 1);
      selectedPlayer = playersArr[index];
    }
    // mutate by reference.
    selectedPlayer.isCzar = true;
    return playersArr[index]._id;
  }

  private pickBlackCard(): Promise<Card> {
    const index = this.getRandomIndex(this.blackCards.length - 1);
    // Remove the card so it cannot be chosen again.
    this.blackCards.splice(index, 1);
    return this.broker.call('cards.get', { id: this.blackCards[index] });
  }

  private pickWhiteCard(): string {
    const index = this.getRandomIndex(this.whiteCards.length - 1);
    // Remove the card so it cannot be chosen again.
    this.whiteCards.splice(index, 1);
    return this.whiteCards[index];
  }

  // Given a player, deal all the white cards to it.
  protected dealWhiteCards(player: GamePlayer): Promise<void> {
    const cardsNeeded = 10 - player.cards.length;
    if (!cardsNeeded) {
      return;
    }

    for (let i = 0; i < cardsNeeded; i++) {
      player.cards.push(this.pickWhiteCard());
    }

    // Get all the cards and deal them to the player.
    return this.broker.call('cards.get', { id: player.cards })
      .then(cards => this.broker.emit('games.deal', { clientId: player._id, cards }));
  }

  private async ensurePlayersHaveCards(players: { [id: string]: GamePlayer }) {
    const cardPlayers = Object.values(players).map(player => this.dealWhiteCards(player));
    return Promise.all(cardPlayers);
  }

  protected async startTurn(players: { [id: string]: GamePlayer }): Promise<TurnData> {
    this._turnData.blackCard = null;
    this._turnData.czar = null;

    // mutate by reference. ensure we reset the czar.
    Object.values(players).forEach(player => player.isCzar = false);

    this._turnData.turn += 1;
    this._turnData.czar = this.pickCzar(players);
    this._turnData.blackCard = await this.pickBlackCard();
    await this.ensurePlayersHaveCards(players);
    return this._turnData;
  }

  protected submitCards(clientId: string, cards: string[]): void {
    if (this.turnData.czar === clientId) {
      throw new Error('The czar is not allowed to play the round.');
    }
    if (clientId in this.selectedCards) {
      throw new Error('You have already submitted your cards.');
    }

    if (this.turnData.blackCard.pick !== cards.length) {
      throw new Error(`You must select exactly ${this.turnData.blackCard.pick} cards.`);
    }
    this.selectedCards[clientId] = cards;
  }

  protected selectWinner(winner: string): Promise<Card[]> {
    const winningCards = this.selectedCards[winner];
    // reset selected cards.
    this.selectedCards = {};
    return this.broker.call('cards.get', { id: winningCards });
  }

  protected async populatedSelectedCards() {
    const allSelectedCards = Object.values(this.selectedCards).flat(1);
    const cards: Card[] = await this.broker.call('cards.get', { id: allSelectedCards });
    const entries = Object.entries(this.selectedCards).map(([key, value]) => {
      const populatedCards = value.map(v => cards.find(c => c._id === v));
      return [key, populatedCards];
    });
    return Object.fromEntries(entries);
  }

  protected hasEveryoneSelected(players: { [id: string]: GamePlayer }): boolean {
    // ensure every player, has a property in the selected cards map.
    return Object.keys(players).every(player => {
      return player in this.selectedCards || this.turnData.czar === player;
    });
  }
}
