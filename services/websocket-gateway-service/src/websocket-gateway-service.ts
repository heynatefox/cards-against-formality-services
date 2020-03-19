import ApiGateway from 'moleculer-web';
import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import redis from 'socket.io-redis';
import SocketIO from 'socket.io';

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
  private server: SocketIO.Server = null;

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
        started: () => {
          this.server = SocketIO(this.httpServer, { path: '/socket' });
          this.server.adapter(redis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT }));
          return null;
        },
        actions: {
          health: this.health
        }
      }
    );
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
