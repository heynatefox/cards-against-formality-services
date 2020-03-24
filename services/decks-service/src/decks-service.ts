import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';

import dbMixin from '../mixins/db.mixin';

/**
 * Decks Service handles collating a set of cards in a deck structure.
 *
 * @export
 * @class DecksService
 * @extends {Service}
 */
export default class DecksService extends Service {

  /**
   * Validation Schema for Deck.
   *
   * @private
   * @memberof DecksService
   */
  private validationSchema = {
    name: 'string',
    whiteCards: { type: 'array', items: 'string', default: [] },
    blackCards: { type: 'array', items: 'string', default: [] },
  };

  /**
   * Creates an instance of DecksService.
   *
   * @param {ServiceBroker} _broker
   * @memberof DecksService
   */
  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'decks',
        mixins: [
          dbMixin('decks')
        ],
        settings: {
          entityValidator: this.validationSchema,
          populates: {
            whiteCards: {
              action: 'cards.get'
            },
            blackCards: {
              action: 'cards.get'
            },
          }
        },
        actions: {
          health: this.health
        },
        entityCreated: this.entityCreated,
        entityUpdated: this.entityUpdated,
        entityRemoved: this.entityRemoved,
        afterConnected: async () => {
          await this.broker.waitForServices('cards');
          const count = await this.adapter.count();
          if (count === 0) {
            this.seedDb();
          }
        }
      },
    );
  }

  /**
   * Seed the db. **Remove in prod**.
   *
   * @private
   * @returns
   * @memberof DecksService
   */
  private async seedDb() {
    const _cards: any[] = await this.broker.call('cards.find', { query: {} });
    const { whiteCards, blackCards } = _cards.reduce((acc, card) => {
      if (card.cardType === 'black') {
        acc.blackCards.push(card._id);
      } else {
        acc.whiteCards.push(card._id);
      }
      return acc;
    }, { whiteCards: [], blackCards: [] });
    return this.broker.call(`${this.name}.create`, { name: 'Base cards', whiteCards, blackCards });
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
   * @memberof DecksService
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
   * @memberof DecksService
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
   * @memberof DecksService
   */
  private entityRemoved(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.removed`, json);
  }
}
