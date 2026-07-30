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
// Authored measurement candidates, resolved to live card ids by text match.
import * as resolvedSignal from './data/signal-tags-resolved.json';
import { selectProbe, isProbeBot, TaggedCard, CardTags, TasteProfile, Probe } from './solo-probe';
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

  // ── Solo probe pool ────────────────────────────────────────────────────
  // Built once from the tag catalogues. Contains every card the probe engine
  // may hand to a bot, with its full tag vector.
  private static probePool: TaggedCard[] | null = null;

  protected getProbePool(): TaggedCard[] {
    if (TurnHandler.probePool) { return TurnHandler.probePool; }
    const v2 = signalTags as any;
    const v1 = tasteTags as any;
    const sig = resolvedSignal as any;
    const pool: TaggedCard[] = [];
    for (const id of Object.keys(v2)) {
      if (id === 'default') { continue; }   // json-module artefact
      const t = v2[id] || {};
      const b = v1[id] || {};
      const tags: any = {
        heat: t.h, mode: t.m, register: t.r, sincerity: t.s,
        flavors: t.f, cls: t.cls,
      };
      if (b.e != null) { tags.edge = b.e; }
      pool.push({ id, text: '', tags: tags as CardTags });
    }
    for (const id of Object.keys(sig)) {
      if (id === 'default') { continue; }
      const g = sig[id] || {};
      if (g.cardType && g.cardType !== 'white') { continue; }  // prompts are not playable answers
      const tags: any = {
        heat: g.h, cls: g.cls,
        measuresPrimary: g.measures && g.measures.primary,
      };
      // Wave-2 cards carry full axis vectors; ladder rungs share them by
      // design, so contrastScore sees zero confound inside a ladder and the
      // engine reaches for them on its own.
      if (g.m != null) { tags.mode = g.m; }
      if (g.r != null) { tags.register = g.r; }
      if (g.s != null) { tags.sincerity = g.s; }
      if (g.f) { tags.flavors = g.f; }
      pool.push({ id, text: '', tags: tags as CardTags });
    }
    TurnHandler.probePool = pool;
    return pool;
  }

  /** Seeded-control membership: the 86 empirically dead cards. */
  public isControlCard(id: string): boolean {
    return BENCHED.has(id);
  }

  /** Tag vector for one card id, for profile updates and the round writer. */
  public tagsForCard(id: string): CardTags | null {
    const g = (resolvedSignal as any)[id];
    if (g && g.cardType !== 'black') {
      const t: any = { heat: g.h, cls: g.cls, measuresPrimary: g.measures && g.measures.primary };
      if (g.m != null) { t.mode = g.m; }
      if (g.r != null) { t.register = g.r; }
      if (g.s != null) { t.sincerity = g.s; }
      if (g.f) { t.flavors = g.f; }
      if (g.ladder) { t.ladder = g.ladder; }
      if (g.paraphrase) { t.paraphrase = g.paraphrase; }
      return t as CardTags;
    }
    const a = (signalTags as any)[id];
    const b = (tasteTags as any)[id];
    if (!a && !b) { return null; }
    const t: any = {};
    if (a) {
      if (a.h != null) { t.heat = a.h; }
      if (a.m != null) { t.mode = a.m; }
      if (a.r != null) { t.register = a.r; }
      if (a.s != null) { t.sincerity = a.s; }
      if (a.f) { t.flavors = a.f; }
      if (a.cls) { t.cls = a.cls; }
    }
    if (b && b.e != null) { t.edge = b.e; }
    return Object.keys(t).length ? t as CardTags : null;
  }


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

        // Seeded controls: a sprinkle of the benched dead-weight cards goes
        // back into the draw at ~1-in-40 density. They are the attention
        // check that certifies per-player data quality: every card in the
        // deal is otherwise at least decent, so a player who picks a known
        // dud from a full hand is flagging their own noise. Rows mark them.
        const dudPool = Array.from(BENCHED).filter(id => _whiteCards.includes(id));
        const dudCount = Math.min(dudPool.length, Math.max(1, Math.floor(servableWhites.length / 40)));
        for (let i = 0; i < dudCount; i++) {
          const idx = this.getRandomIndex(dudPool.length - 1);
          servableWhites.push(dudPool.splice(idx, 1)[0]);
        }

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
    const playersArr = Object.values(players).filter(player => player._id !== 'rando-cardrissian' && !isProbeBot(player._id));
    // Every human has left and only synthetic seats remain: there is nobody
    // to judge, so refuse the round cleanly. The empty-room watchdog destroys
    // the game within a sweep; this used to be a TypeError retry loop.
    if (!playersArr.length) {
      throw new Error('no human players left to judge');
    }
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
  private async pickBlackCard(blackCards: string[], requirePickOne = false): Promise<Card> {
    if (requirePickOne) {
      // Solo rounds: every bot plays exactly one card, so multi-pick prompts
      // cannot be answered. Draw until a pick-1 prompt lands; rejects go back
      // to the END of the deck so they are not permanently lost, and the try
      // cap keeps a pathological deck from looping.
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = await this.pickBlackCard(blackCards, false);
        if ((candidate.pick || 1) === 1) { return candidate; }
        blackCards.push(candidate._id);
      }
      // Deck is overwhelmingly multi-pick: fall through and accept whatever
      // comes; the bots will sit the round out and the czar sees a no-winner.
    }
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
      // Probe bots are stocked by the probe engine in startTurn; dealing them
      // ten deck cards each would only starve the humans' deck.
      if (isProbeBot(player._id)) { continue; }
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
      // Bots draw from the probe pool, not the deck; counting them here would
      // end solo games early with hundreds of cards still undealt.
      if (isProbeBot(player._id)) { return totalRequired; }
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
    const solo = !!(room && room.options && (room.options as any).soloMode);

    // mutate by reference. ensure we reset the czar.
    Object.values(players).forEach(player => player.isCzar = false);

    // Timing only, no behaviour change. Players report sitting on the
    // between-rounds screen far longer than the 10s that phase is meant to
    // last; one game was measured holding turnSetup for 23s. Nothing throws
    // and nothing logs at ERROR, so the time is going into one of the awaits
    // below and this says which.
    const t0 = Date.now();

    turnData.turn += 1;
    // players mutated by reference.
    turnData.czar = this.pickCzar(turns, players);
    const tCzar = Date.now();
    // mutate black and white cards by reference
    turnData.blackCard = await this.pickBlackCard(blackCards, solo);
    const tBlack = Date.now();
    // House rule "Packing Heat": everyone draws an extra card on 2+ pick
    // prompts. The extra card is absorbed next round (hands top up to 10).
    const packingHeat = !!(room && (room as any).options && (room as any).options.packingHeat);
    const handSize = packingHeat && turnData.blackCard && turnData.blackCard.pick >= 2 ? 11 : 10;
    const newWhiteCards = await this.ensurePlayersHaveCards(players, whiteCards, handSize);
    const tDeal = Date.now();

    // ── Solo: stock the bots from the probe engine ─────────────────────────
    // Each round is a paired comparison on the axis the player's profile is
    // least certain about. The engine picks the cards; each bot's hand IS its
    // assigned card, so the normal submit path just works.
    let soloProbe: any = null;
    if (solo) {
      const humanId = Object.keys(players).find(id => !isProbeBot(id) && id !== 'rando-cardrissian');
      const botIds = Object.keys(players).filter(id => isProbeBot(id));
      if (humanId && botIds.length) {
        const fetched: any = await this.broker
          .call<any, any>('games.solo-profile-fetch', { player: humanId })
          .catch(() => null);
        const profile: TasteProfile = fetched && fetched.mean ? fetched : { mean: {}, n: {} };

        // Test-retest: when a pair served 7+ days ago is eligible, sometimes
        // re-serve it verbatim. Same person, same choice, weeks apart: the
        // agreement rate is the corpus's measured noise floor.
        const retestCandidate = fetched && fetched.retestCandidate;
        const useRetest = !!(retestCandidate && Math.random() < 0.2
          && (retestCandidate.cards || []).length >= Math.min(2, botIds.length));

        let probe: Probe | null = null;
        if (useRetest) {
          const byId: { [id: string]: CardTags | null } = {};
          retestCandidate.cards.forEach((id: string) => { byId[id] = this.tagsForCard(id); });
          probe = {
            axis: retestCandidate.axis,
            cards: retestCandidate.cards.map((id: string) => ({ id, text: '', tags: byId[id] || {} })),
            score: 0,
            authored: false,
          };
        } else {
          probe = selectProbe(this.getProbePool(), profile, botIds.length);
        }

        if (probe) {
          const botCards: { [botId: string]: string } = {};
          botIds.forEach((botId, i) => {
            const card = probe.cards[i % probe.cards.length];
            players[botId].cards = [card.id];
            botCards[botId] = card.id;
          });

          // Seeded control: roughly 1-in-8 non-retest rounds, the last bot
          // swaps its probe card for a known dud. Picking the dud over the
          // real options is the per-player attention flag. Never counted as
          // a taste observation (see onWinnerSelected).
          let controlBot: string | null = null;
          let controlCard: string | null = null;
          if (!useRetest && botIds.length >= 3 && BENCHED.size && Math.random() < 0.125) {
            const duds = Array.from(BENCHED);
            controlBot = botIds[botIds.length - 1];
            controlCard = duds[this.getRandomIndex(duds.length - 1)];
            players[controlBot].cards = [controlCard];
            botCards[controlBot] = controlCard;
          }

          soloProbe = {
            axis: probe.axis,
            score: probe.score,
            authored: probe.authored,
            targetPlayer: humanId,
            botCards,
            controlBot,
            controlCard,
            retest: useRetest ? { servedTs: retestCandidate.ts, originalWinner: retestCandidate.winnerCard || null } : null,
          };

          // Record what was served so a future session can re-ask it.
          this.broker.call('games.solo-probe-served', {
            player: humanId,
            axis: probe.axis,
            cards: probe.cards.map(c => c.id),
            retestOf: useRetest ? retestCandidate.ts : undefined,
          }).catch(() => undefined);
        } else {
          this.logger.warn(`solo: probe selection failed for game ${game._id}; bots sit out this round`);
        }
      }
    }

    // tslint:disable-next-line: max-line-length
    await this.broker.call('games.update', { id: game._id, selectedCards: {}, players, whiteCards: newWhiteCards, blackCards, turnData, turnStartedAt: Date.now(), submittedAt: {}, predictions: {}, lastPredictions: {}, czarDeliberationMs: null, soloProbe });
    const tUpdate = Date.now();

    // Only complain when it actually went slowly, so this stays quiet in the
    // normal case and is easy to find when it does not.
    if (tUpdate - t0 > 1500) {
      this.logger.warn(
        `slow startTurn ${game._id}: total=${tUpdate - t0}ms ` +
        `czar=${tCzar - t0}ms blackCard=${tBlack - tCzar}ms deal=${tDeal - tBlack}ms update=${tUpdate - tDeal}ms ` +
        `turns=${(turns || []).length} white=${(newWhiteCards || []).length} black=${(blackCards || []).length} ` +
        `players=${Object.keys(players || {}).length}`,
      );
    }
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
