import { GamePlayer, GameInterface } from './game';
import { ServiceBroker, LoggerInstance } from 'moleculer';
// Humor-style tags per card (tagset v0) for the stratified dealer
import * as cardTags from './data/card-tags-v0.json';
// Measurement-grade taste tags (tagset v1: edge/mode/register/sincerity per
// the content-metadata standard) — drives the v2 dealer and prompt weighting
import * as tasteTags from './data/card-tags-v1.json';
import * as promptTags from './data/prompt-tags-v1.json';
// Tagset v2 (partner-scored: heat + flavors) + the bench list + candidate decks
import * as signalTags from './data/card-tags-v2.json';
import * as benchList from './data/bench-v1.json';
import { signalRegistry } from './signal-registry';

const BENCHED = new Set<string>(((benchList as any).benched || []) as string[]);

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
        if (!decks) {
          this.logger.warn('fetchCards: decks.get returned null/undefined');
          return { whiteCards: _whiteCards, blackCards: _blackCards };
        }
        decks.forEach(deck => {
          const { whiteCards, blackCards } = deck;
          _whiteCards.push(...whiteCards);
          _blackCards.push(...blackCards);
        });

        // Card hygiene (measurement pilot): drop the 86 benched dead-weight
        // cards and comfort-gate heat 5 (maximum transgression) out of the
        // deal entirely. Cards stay in the DB and in stats; they just stop
        // being dealt. Reversible by emptying bench-v1.json.
        const v2 = signalTags as { [id: string]: { h: number } };
        const servableWhites = _whiteCards.filter(id => !BENCHED.has(id) && !(v2[id] && v2[id].h >= 5));

        // Candidate injection: the Signal decks ride along in every game's
        // draw pile (the stratified picker caps them at 2 per hand). Prompts
        // join the black pile at ~1-in-4 density.
        if (signalRegistry.ready) {
          servableWhites.push(...signalRegistry.whiteIds);
          const prompts = Array.from(signalRegistry.promptIds);
          const target = Math.min(prompts.length, Math.max(4, Math.floor(_blackCards.length / 3)));
          for (let i = 0; i < target; i++) {
            const idx = this.getRandomIndex(prompts.length - 1);
            _blackCards.push(prompts.splice(idx, 1)[0]);
          }
        }
        return { whiteCards: servableWhites, blackCards: _blackCards };
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

    // pick czar — Rando plays but never judges
    const playersArr = Object.values(players).filter(player => player._id !== 'rando-cardrissian');
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
  private async pickBlackCard(blackCards: string[]): Promise<Card> {
    // Prompt weighting: 85% of rounds draw a measurement-fork prompt (grade
    // A/B in prompt-tags-v1 — both a clean and a spicy card, or a grounded
    // and an absurd card, genuinely land). 15% keep the pure-fun tail alive.
    const pTags = promptTags as { [id: string]: { grade?: string } };
    let index = this.getRandomIndex(blackCards.length - 1);
    if (Math.random() < 0.85) {
      const forkIndexes: number[] = [];
      for (let i = 0; i < blackCards.length; i++) {
        const g = pTags[blackCards[i]] && pTags[blackCards[i]].grade;
        if (g === 'A' || g === 'B' || signalRegistry.promptIds.has(blackCards[i])) { forkIndexes.push(i); }
      }
      if (forkIndexes.length > 0) {
        index = forkIndexes[this.getRandomIndex(forkIndexes.length - 1)];
      }
    }
    const id = blackCards[index];
    // Remove the card so it cannot be chosen again.
    blackCards.splice(index, 1);
    const card = await this.broker.call<Card, any>('cards.get', { id }).catch(err => {
      this.logger.warn(`pickBlackCard: card not found for id ${id}: ${err.message}`);
      return null;
    });
    if (!card) {
      throw new Error(`Card not found: ${id}`);
    }
    return card;
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
   * Stratified pick for the psychometric pilot: sample a handful of random
   * candidates and deal the one whose humor-style tag is least represented
   * in the player's current hand. Hands end up spread across styles, which
   * turns every play into a calibrated choice between styles instead of an
   * accident of the shuffle. Falls back to pure random when tags are
   * unavailable. Still random WITHIN a style, so gameplay feels identical.
   *
   * @private
   * @param {string[]} whiteCards
   * @param {string[]} hand  the player's current card ids
   * @returns {string}
   * @memberof TurnHandler
   */
  private pickWhiteCardStratified(whiteCards: string[], hand: string[]): string {
    // Empty deck: there is nothing to pick. Callers treat a falsy return as
    // "stop dealing" rather than pushing undefined into a hand.
    if (!whiteCards.length) { return null as any; }
    // v2 (tagset card-tags-v1): stratify hands on the TASTE VECTOR — every
    // hand should span edge tiers 1/2/3+ and hold at least one grounded and
    // one absurd card, so each play is a choice between taste positions
    // (the authoring spec's stratified deal). Random within a stratum, so
    // gameplay feels identical. Falls back to v0 style-spread for untagged
    // cards, and to pure random when nothing is tagged.
    const v1 = tasteTags as { [id: string]: { e: number; m: number; grade?: string } };
    const v0 = cardTags as { [id: string]: { t: string[]; i: number } };
    const tier = (e: number) => (e <= 1 ? 1 : e === 2 ? 2 : 3);

    const tiersInHand: { [t: number]: number } = {};
    let groundedInHand = 0;
    let absurdInHand = 0;
    let candidatesInHand = 0;
    const styleCounts: { [tag: string]: number } = {};
    for (const id of hand) {
      const t1 = v1[id];
      if (t1) {
        tiersInHand[tier(t1.e)] = (tiersInHand[tier(t1.e)] || 0) + 1;
        if (t1.m <= -1) { groundedInHand++; }
        if (t1.m >= 1) { absurdInHand++; }
      }
      if (signalRegistry.metaById[id]) { candidatesInHand++; }
      const s = v0[id] && v0[id].t && v0[id].t[0];
      if (s) { styleCounts[s] = (styleCounts[s] || 0) + 1; }
    }

    const K = Math.min(8, whiteCards.length);
    let bestIndex = this.getRandomIndex(whiteCards.length - 1);
    let bestScore = -Infinity;
    for (let n = 0; n < K; n++) {
      const index = this.getRandomIndex(whiteCards.length - 1);
      const id = whiteCards[index];
      // Candidate quota: never more than 2 unproven cards in a hand; nudge
      // toward exactly 1 so exposures accumulate without degrading hands.
      const isCandidate = !!signalRegistry.metaById[id];
      if (isCandidate && candidatesInHand >= 2) { continue; }
      const t1 = v1[id];
      let score = Math.random(); // tiebreak stays random
      if (isCandidate && candidatesInHand === 0) { score += 1.5; }
      if (t1) {
        if (!tiersInHand[tier(t1.e)]) { score += 2; }         // fills a missing edge tier
        if (t1.m <= -1 && groundedInHand === 0) { score += 2; } // fills the grounded slot
        if (t1.m >= 1 && absurdInHand === 0) { score += 2; }    // fills the absurd slot
        if (t1.grade === 'A' || t1.grade === 'B') { score += 1; } // prefer discriminators
      } else {
        // v0 fallback: least-represented style, scaled under the v1 scores
        const s = v0[id] && v0[id].t && v0[id].t[0];
        if (s && !styleCounts[s]) { score += 1; }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const id = whiteCards[bestIndex];
    whiteCards.splice(bestIndex, 1);
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
      .then(cards => {
        if (!cards) {
          this.logger.warn(`emitCardsToPlayer: no cards found for player ${player._id}`);
          return;
        }
        return this.broker.emit('games.deal', { clientId: player._id, cards });
      });
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
  protected async dealWhiteCards(player: GamePlayer, whiteCards: string[], handSize = 10): Promise<string[]> {
    // Self-heal: an exhausted deck used to fill hands with undefined ids,
    // which made the card lookup return nothing and the player see an empty
    // hand ("didn't get cards"). Strip any such ghosts before dealing so
    // affected players recover on their next deal.
    player.cards = (player.cards || []).filter(id => typeof id === 'string' && id.length > 0);

    // >= guard: with Packing Heat a player can briefly hold more cards than
    // the current target; never try to "deal down" (it would loop forever).
    if (player.cards.length >= handSize) {
      await this.emitCardsToPlayer(player);
      return whiteCards;
    }

    while (player.cards.length < handSize && whiteCards.length > 0) {
      const picked = this.pickWhiteCardStratified(whiteCards, player.cards);
      if (typeof picked !== 'string' || !picked.length) { break; } // deck starved; deal what we have
      player.cards.push(picked);
    }
    if (player.cards.length < handSize) {
      this.logger.warn(`dealWhiteCards: deck exhausted, player ${player._id} holds ${player.cards.length}/${handSize}`);
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
  private async ensurePlayersHaveCards(players: { [id: string]: GamePlayer }, whiteCards: string[], handSize = 10) {
    for (const player of Object.values(players)) {
      whiteCards = await this.dealWhiteCards(player, whiteCards, handSize);
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
      const cardsRequired = Math.max(0, 10 - player.cards.length);
      return totalRequired + cardsRequired;
    }, 0);

    return whiteCardsRequired <= whiteCards.length && !!blackCards.length;
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
    // House rule "Packing Heat": everyone draws an extra card on 2+ pick
    // prompts. The extra card is absorbed next round (hands top up to 10).
    const packingHeat = !!(room && (room as any).options && (room as any).options.packingHeat);
    const handSize = packingHeat && turnData.blackCard && turnData.blackCard.pick >= 2 ? 11 : 10;
    const newWhiteCards = await this.ensurePlayersHaveCards(players, whiteCards, handSize);

    // tslint:disable-next-line: max-line-length
    await this.broker.call('games.update', { id: game._id, selectedCards: {}, players, whiteCards: newWhiteCards, blackCards, turnData, turnStartedAt: Date.now(), submittedAt: {} });
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
      const fetchedGame = await this.broker.call<GameInterface, any>('games.get', { id: game._id, populate: ['room'] }).catch(err => {
        this.logger.warn(`submitCards: game not found ${game._id}: ${err.message}`);
        return null;
      });
      if (!fetchedGame) {
        throw new Error(`Game not found: ${game._id}`);
      }
      return fetchedGame;
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
    const submittedAtProp = `submittedAt.${clientId}`;

    await this.broker.call('games.update', {
      id: game._id, [playersProp]: newCards, [selectedCardsProp]: cards, [submittedAtProp]: Date.now()
    });
    const updatedGame = await this.broker.call<GameInterface, any>('games.get', { id: game._id, populate: ['room'] }).catch(err => {
      this.logger.warn(`submitCards: game not found after update ${game._id}: ${err.message}`);
      return null;
    });
    if (!updatedGame) {
      throw new Error(`Game not found after update: ${game._id}`);
    }
    return updatedGame;
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
        if (!cards) {
          this.logger.warn(`selectWinner: no cards found for winner ${winner}`);
          return [];
        }
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
    if (!cards) {
      this.logger.warn('populatedSelectedCards: cards.get returned null/undefined');
      return {};
    }
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
