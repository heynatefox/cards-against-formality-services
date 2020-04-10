import ApiGateway from 'moleculer-web';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import redis from 'socket.io-redis';
import SocketIO from 'socket.io';
import DefaultNamespace from './DefaultNamespace';
import GameNamespace from './GameNamespace';
import RoomsNamespace from './RoomsNamespace';

/**
 * WebsocketGatewayService exposes all access to websocket users.
 *
 * @export
 * @class WebsocketGatewayService
 * @extends {Service}
 */
export default class WebsocketGatewayService extends Service {

  /**
   * SocketIO server.
   *
   * @private
   * @type {SocketIO.Server}
   * @memberof WebsocketGatewayService
   */
  private socketServer: SocketIO.Server = null;

  /**
   * Creates an instance of WebsocketGatewayService.
   *
   * @param {ServiceBroker} _broker
   * @memberof WebsocketGatewayService
   */
  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'websocket-gateway',
        mixins: [
          ApiGateway
        ],
        settings: {
          use: [
            compression(),
            cookieParser(),
          ]
        },
        started: () => {
          this.socketServer = SocketIO(this.server, { path: '/socket' });
          this.socketServer.adapter(redis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT }));
          new DefaultNamespace(this.socketServer.of('/'), this.broker, this.logger);
          new RoomsNamespace(this.socketServer.of('/rooms'), this.broker, this.logger);
          new GameNamespace(this.socketServer.of('/games'), this.broker, this.logger);
          return null;
        },
        actions: {
          health: this.health
        },
        events: {
          'rooms.created': ctx => this.emit(ctx, '/rooms', 'rooms', 'created'),
          'rooms.updated': ctx => this.emit(ctx, '/rooms', 'rooms', 'updated'),
          'rooms.removed': ctx => this.emit(ctx, '/rooms', 'rooms', 'removed'),
        }
      }
    );
  }

  private emit(ctx: Context<any>, namespace: string, event: string, updateType: string) {
    this.socketServer.nsps[namespace].emit(event, { updateType, payload: ctx.params });
  }
  /**
   * Get the health data for this service.
   *
   * @private
   * @param {Context} ctx
   * @returns {Promise<NodeHealthStatus>}
   * @memberof WebsocketGatewayService
   */
  private health(ctx: Context): Promise<NodeHealthStatus> {
    return ctx.call('$node.health');
  }
}
