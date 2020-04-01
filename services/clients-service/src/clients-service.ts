import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import { conflict } from 'boom';
import jwt from 'jsonwebtoken';

import dbMixin from '../mixins/db.mixin';

/**
 * Interface that represents the Client object.
 *
 * @interface Client
 */
interface Client {
  username: string;
  socket?: string;
}

/**
 * ClientsService registers users.
 *
 * @export
 * @class ClientsService
 * @extends {Service}
 */
export default class ClientsService extends Service {

  /**
   * Validation schema for users.
   *
   * @private
   * @memberof ClientsService
   */
  private validationSchema = {
    username: { type: 'string', pattern: '^[a-zA-Z0-9]+([_ -]?[a-zA-Z0-9])*$', min: 4, max: 12 },
    socket: { type: 'string', optional: true }
  };

  /**
   * Creates an instance of ClientsService.
   *
   * @param {ServiceBroker} _broker
   * @memberof ClientsService
   */
  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'clients',
        mixins: [
          dbMixin('clients')
        ],
        settings: {
          entityValidator: this.validationSchema
        },
        hooks: {
          before: {
            create: [this.beforeCreate] as any
          }
        },
        actions: {
          health: this.health,
          login: {
            params: {
              username: 'string',
            },
            handler: this.login
          }
        },
        entityCreated: this.entityCreated,
        entityUpdated: this.entityUpdated,
        entityRemoved: this.entityRemoved
      },
    );
  }

  /**
   * Called before a client is created, to check if username is alraedy in use.
   * **This will be deprecated once proper Client auth is in place.**
   *
   * @private
   * @param {Context<Client>} ctx
   * @returns {Promise<Context<Client>>}
   * @memberof ClientsService
   */
  private async beforeCreate(ctx: Context<Client>): Promise<Context<Client>> {
    const { username } = ctx.params;
    const count: number = await ctx.call(`${this.name}.count`, { query: { username } });
    if (count > 0) {
      const err = conflict('Username is already taken. Please try another.', { username }).output;
      throw err;
    }

    return ctx;
  }

  /**
   * Given a payload, asynchronously create a jwt token.
   *
   * @private
   * @param {*} payload
   * @returns
   * @memberof ClientsService
   */
  private createJwtToken(payload: any) {
    return new Promise((resolve, reject) => {
      jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' }, (err, token) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(token);
      });
    });
  }

  /**
   * Register a user with the given username.
   *
   * @private
   * @param {Context<{ username: string }>} ctx
   * @returns {Promise<{ message: string }>}
   * @memberof ClientsService
   */
  private async login(ctx: Context<{ username: string }, any>): Promise<{ message: string }> {
    const user = await ctx.call(`${this.name}.create`, ctx.params);
    const token = await this.createJwtToken(user);
    ctx.meta.token = token;
    return { message: 'Login successful' };
  }

  /**
   * Get the health data for this service.
   *
   * @private
   * @param {Context} ctx
   * @returns {Promise<NodeHealthStatus>}
   * @memberof ClientsService
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
   * @memberof ClientsService
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
   * @memberof ClientsService
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
   * @memberof ClientsService
   */
  private entityRemoved(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.removed`, json);
  }
}
