import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import dbMixin from '@cards-against-formality/db-mixin';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';
// Will remove seeds in prod.
import cardData from '../seeds/cards.json';

/**
 * CardsService acts as a data store with a transactional outbox, for playing cards.
 *
 * @export
 * @class CardsService
 * @extends {Service}
 */
export default class CardsService extends Service {

  /**
   * Validation schema for cards being added to the Cards Service mongodb.
   *
   * @private
   * @memberof CardsService
   */
  private validationSchema = {
    text: 'string',
    cardType: { type: 'enum', values: ['white', 'black'] },
    pick: { type: 'number', optional: true },
  };

  /**
   * Creates an instance of CardsService.
   *
   * @param {ServiceBroker} _broker
   * @memberof CardsService
   */
  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'cards',
        mixins: [
          dbMixin('cards'),
          CacheCleaner([
            'cache.clean.cards'
          ]),
        ],
        settings: {
          entityValidator: this.validationSchema
        },
        actions: {
          health: this.health
        },
        entityCreated: this.entityCreated,
        entityUpdated: this.entityUpdated,
        entityRemoved: this.entityRemoved,
        afterConnected: async () => {
          const count = await this.adapter.count();
          if (count === 0) {
            await this.seedDb();
            await this.broker.broadcast('cache.clean.cards');
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
   * @memberof CardsService
   */
  private seedDb() {
    const { blackCards, whiteCards } = cardData;
    const blackCardPromises = blackCards.map(card => {
      return Object.assign(card, { cardType: 'black' });
    });

    const whiteCardPromises = whiteCards.map(card => {
      return { text: card, cardType: 'white' };
    });

    return this.adapter.insertMany([...blackCardPromises, ...whiteCardPromises]);
  }

  /**
   * Get the health data for this service.
   *
   * @private
   * @param {Context} ctx
   * @returns {Promise<NodeHealthStatus>}
   * @memberof CardsService
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
   * @memberof CardsService
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
   * @memberof CardsService
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
   * @memberof CardsService
   */
  private entityRemoved(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.removed`, json);
  }
}
