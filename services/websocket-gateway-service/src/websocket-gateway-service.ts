import ApiGateway from 'moleculer-web';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import { Server } from 'socket.io';
import { Redis } from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import admin from 'firebase-admin';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';

import serviceAccount from './auth.json';
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
  private socketServer: Server = null;

  /**
   * Admin Auth provider.
   *
   * @private
   * @memberof WebsocketGatewayService
   */
  private admin = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as any),
    databaseURL: 'https://cards-against-formality.firebaseio.com'
  }, 'websocket-gateway');

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
          ApiGateway,
          CacheCleaner([
            'cache.clean.clients'
          ])
        ],
        settings: {
          use: [
            compression(),
            cookieParser(),
          ]
        },
        started: () => {
          const pubClient = new Redis(parseInt(process.env.REDIS_PORT), process.env.REDIS_HOST);
          const subClient = pubClient.duplicate();
          this.socketServer = new Server(
            this.server,
            { path: '/socket', allowEIO3: true, cors: { origin: '*', methods: ['*'], allowedHeaders: ['*'] } }
          ).adapter(createAdapter(
            pubClient,
            subClient,
            { 
              requestsTimeout: 10000,
            }
          ));
          new RoomsNamespace(this.socketServer.of('/rooms'), this.broker, this.logger, this.admin);
          // Handles users joining a game room of roomId.
          new GameNamespace(this.socketServer.of('/games'), this.broker, this.logger, this.admin);
          return null;
        },
        actions: {
          health: this.health
        },
        events: {
          'rooms.created': ctx => this.emitRoomUpdate(ctx, 'created'),
          'rooms.updated': ctx => this.emitRoomUpdate(ctx, 'updated'),
          'rooms.removed': ctx => this.emitRoomUpdate(ctx, 'removed'),
          'rooms.player.kicked': ctx => this.sendMessageToClient(ctx, { type: 'kicked' }),
          'games.turn.updated': ctx => this.handleGameUpdate(ctx),
          'games.deal': ctx => this.handleCardDealing(ctx),
          'games.turn.updated.client': ctx => this.handleGameUpdate(ctx),
        }
      }
    );
  }

  /**
   * Propagate the payload from the given context, to a namespace with the given event type.
   *
   * @private
   * @param {Context<any>} ctx
   * @param {string} namespace
   * @param {string} event
   * @param {string} updateType
   * @memberof WebsocketGatewayService
   */
  private emit(ctx: Context<any>, namespace: string, event: string, updateType: string) {
    this.socketServer._nsps.get(namespace).emit(event, { updateType, payload: ctx.params });
  }

  /**
   * Pass the room update to the relevant namespaces.
   *
   * @private
   * @param {Context<any>} ctx
   * @param {string} updateType
   * @memberof WebsocketGatewayService
   */
  private emitRoomUpdate(ctx: Context<any>, updateType: string) {
    this.emit(ctx, '/rooms', 'rooms', updateType);
    this.sendRoomChangeToGame(ctx, updateType);
  }

  /**
   * Populate the given room update and send an event to the corresponding room.
   *
   * @private
   * @param {Context<any>} ctx
   * @param {string} updateType
   * @memberof WebsocketGatewayService
   */
  private async sendRoomChangeToGame(ctx: Context<any>, updateType: string) {
    const room = Object.assign({}, ctx.params);

    // Get clients from cache, This should have a smaller time complexity than making one request and reducing.
    const players = await ctx.call('clients.get', { id: room.players, fields: ['username', '_id'] });
    const spectators = await ctx.call('clients.get', { id: room.spectators, fields: ['username', '_id'] });
    room.players = players;
    room.spectators = spectators;

    this.socketServer._nsps.get('/games').to(ctx.params._id).emit('room', { updateType, payload: room });
  }

  /**
   * Handle passing the cards to the correct client.
   *
   * @private
   * @param {Context<{ clientId: string; cards: any[] }>} ctx
   * @memberof WebsocketGatewayService
   */
  private async handleCardDealing(ctx: Context<{ clientId: string; cards: any[] }>) {
    const { clientId, cards } = ctx.params;
    const client: any = await ctx.call('clients.get', { id: clientId });
    this.socketServer._nsps.get('/games').to(client.socket).emit('deal', { payload: cards });
  }

  /**
   * Send the game update to the players that are in the game.
   *
   * @private
   * @param {Context<any>} ctx
   * @memberof WebsocketGatewayService
   */
  private async handleGameUpdate(ctx: Context<any>) {
    // if a client id is specified, this is intended for a single client.
    if (ctx.params.clientId && ctx.params.gameData) {
      const client: any = await ctx.call('clients.get', { id: ctx.params.clientId });
      this.socketServer._nsps.get('/games').to(client.socket).emit('game', { payload: ctx.params.gameData });
      return;
    }

    // Only emit to the players in the room associated with the game.
    this.socketServer._nsps.get('/games').to(ctx.params.roomId).emit('game', { payload: ctx.params });
  }

  /**
   * Send a payload to a specific client as a message event.
   *
   * @private
   * @param {Context<{ clientId: string }>} ctx
   * @param {*} payload
   * @memberof WebsocketGatewayService
   */
  private async sendMessageToClient(ctx: Context<{ clientId: string }>, payload: any) {
    const { clientId } = ctx.params;
    const client: any = await ctx.call('clients.get', { id: clientId });
    this.socketServer._nsps.get('/').to(client.socket).emit('message', { payload });
    this.socketServer._nsps.get('/games').to(client.socket).emit('message', { payload });
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
