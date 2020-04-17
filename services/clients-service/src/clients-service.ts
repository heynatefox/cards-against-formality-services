import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import { conflict, unauthorized } from 'boom';
import jwt from 'jsonwebtoken';

import HealthCheckMixin from '@cards-against-formality/health-check-mixin';
import dbMixin from '@cards-against-formality/db-mixin';

/**
 * Interface that represents the Client object.
 *
 * @interface Client
 */
interface Client {
  _id: string;
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
    _id: { type: 'string' },
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
          dbMixin('clients'),
          HealthCheckMixin() as any
        ],
        settings: {
          entityValidator: this.validationSchema
        },
        actions: {
          health: this.health,
          login: {
            params: {
              displayName: 'string',
              _id: 'string',
            },
            handler: this.login
          },
          renew: this.renew
        },
        events: {
          'websocket-gateway.client.connected': this.onSocketConnection,
          'rooms.player.joined': this.onRoomJoin,
          'rooms.player.left': this.onRoomLeave,
          'rooms.spectator.joined': this.onRoomJoin,
          'rooms.spectator.left': this.onRoomLeave,
        },
        entityCreated: this.entityCreated,
        entityUpdated: this.entityUpdated,
        entityRemoved: this.entityRemoved
      },
    );
  }

  /**
   * When a client joins a room, update the roomId to reflect the joined room.
   *
   * @private
   * @param {Context<{ clientId: string; roomId: string }>} ctx
   * @returns
   * @memberof ClientsService
   */
  private onRoomJoin(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    return ctx.call(`${this.name}.update`, { id: clientId, roomId })
      .catch(err => { this.logger.error('Unable to add client to room', { clientId, roomId }); });
  }

  /**
   * When a client leaves a room. Ensure the roomId is removed from the client.
   *
   * @private
   * @param {Context<{ clientId: string; roomId: string }>} ctx
   * @returns
   * @memberof ClientsService
   */
  private async onRoomLeave(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    const count = await ctx.call(`${this.name}.count`, { query: { id: clientId, roomId } });
    if (count <= 0) {
      this.logger.warn('Client tried to leave a room its no longer in', { clientId, roomId });
      return;
    }

    return ctx.call(`${this.name}.update`, { id: clientId, roomId: null })
      .catch(err => { this.logger.error(err); });
  }

  /**
   * Register a user with the given username.
   *
   * @private
   * @param {Context<Client>} ctx
   * @returns {Promise<{ message: string }>}
   * @memberof ClientsService
   */
  private async login(ctx: Context<Client, any>): Promise<Client> {
    return ctx.call<any, any>(`${this.name}.get`, { id: ctx.params._id })
      .catch(() => ctx.call<any, any>(`${this.name}.create`, ctx.params));
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
