import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import { conflict, unauthorized } from 'boom';
import jwt from 'jsonwebtoken';

import dbMixin from '@cards-against-formality/db-mixin';

/**
 * Interface that represents the Client object.
 *
 * @interface Client
 */
interface Client {
  _id: string;
  username: string;
  displayName: string;
  socket?: string;
  roomId?: string;
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
    displayName: { type: 'string', pattern: '^[a-zA-Z0-9]+([_ -]?[a-zA-Z0-9])*$', min: 4, max: 12 },
    socket: { type: 'string', optional: true },
    roomId: { type: 'string', optional: true }
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
          },
          renew: this.renew
        },
        events: {
          'websocket-gateway.client.connected': this.onSocketConnection
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
    let { username } = ctx.params;
    // Ensure we store store the username as lowercase. To avoid duplicates.
    const displayName = username;
    username = username.toLocaleLowerCase();
    const count: number = await ctx.call(`${this.name}.count`, { query: { username } });
    if (count > 0) {
      const err = conflict('Username is already taken. Please try another.', { username }).output;
      throw err;
    }

    ctx.params.username = username;
    ctx.params.displayName = displayName;
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
      jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '5m' }, (err, token) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(token);
      });
    });
  }

  /**
   * Try renew the given token. If the user still exists.
   *
   * @private
   * @param {Context<{}, { user: { _id: string }; token?: any }>} ctx
   * @returns {Promise<Client>}
   * @memberof ClientsService
   */
  private async renew(ctx: Context<{}, { user: { _id: string }; token?: any }>): Promise<Client> {
    // generae a new token based on the old token provided.
    const { _id } = ctx.meta.user;
    return ctx.call(`${this.name}.get`, { id: _id })
      .then(async (user: Client) => {
        const token = await this.createJwtToken(user);
        ctx.meta.token = token;
        return Object.assign(user, { jwt: token });
      })
      .catch(() => {
        throw unauthorized('Unable to renew token').output;
      });
  }

  /**
   * Register a user with the given username.
   *
   * @private
   * @param {Context<Client>} ctx
   * @returns {Promise<{ message: string }>}
   * @memberof ClientsService
   */
  private async login(ctx: Context<{ username: string }, any>): Promise<Client> {
    const user: Client = await ctx.call(`${this.name}.create`, ctx.params);
    const token = await this.createJwtToken(user);
    ctx.meta.token = token;
    return Object.assign(user, { jwt: token });
  }

  /**
   * Update the client with the registered socket id.
   *
   * @private
   * @param {Context<Client>} ctx
   * @returns {Promise<any>}
   * @memberof ClientsService
   */
  private onSocketConnection(ctx: Context<Client>): Promise<any> {
    const { _id, socket } = ctx.params;
    return ctx.call(`${this.name}.update`, { id: _id, socket })
      .catch(err => {
        this.logger.error(err);
      });
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
