import compression from 'compression';
import cookieParser from 'cookie-parser';
import ApiGateway from 'moleculer-web';
import { Service, ServiceBroker, Context, NodeHealthStatus, Errors } from 'moleculer';
import admin from 'firebase-admin';
import HealthCheckMixin from '@cards-against-formality/health-check-mixin';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';

import serviceAccount from './auth.json';

/**
 * WebGatewayService acts as the core gateway to access any of the internal services.
 *
 * @export
 * @class WebGatewayService
 * @extends {Service}
 */
export default class WebGatewayService extends Service {

  /**
   * Object used to communicate with the firebase authentication server.
   *
   * @private
   * @memberof WebGatewayService
   */
  private admin = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as any),
    databaseURL: 'https://cards-against-formality.firebaseio.com'
  }, 'web-gateway');

  /**
   * Creates an instance of WebGatewayService.
   *
   * @param {ServiceBroker} _broker
   * @memberof WebGatewayService
   */
  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'web-gateway',
        mixins: [
          ApiGateway,
        ],
        middlewares: [
          HealthCheckMixin(),
          CacheCleaner([
            'cache.clean.clients',
            'cache.clean.cards',
            'cache.clean.decks',
            'cache.clean.rooms',
            'cache.clean.games',
          ])
        ],
        settings: {
          rateLimit: {
            limit: process.env.REQUESTS_PER_MINUTE || 100,
            headers: true,
            key: (req) => {
              return req.headers['x-forwarded-for'] ||
                req.connection.remoteAddress ||
                req.socket.remoteAddress ||
                req.connection.socket.remoteAddress;
            }
          },
          cors: {
            origin: '*',
            methods: ['GET', 'OPTIONS', 'POST', 'PATCH', 'DELETE'],
            allowedHeaders: [],
            exposedHeaders: [],
            credentials: true,
            maxAge: 3600
          },
          use: [
            compression(),
            cookieParser(),
          ],
          routes: [
            {
              path: '/api',
              authorization: true,
              aliases: {
                'PUT /logout': 'clients.logout',
                'PUT /login/renew': 'clients.renew',
                'POST /login': 'clients.login',
                'POST /check/username': 'clients.check-username',

                'GET /cards/:id': 'cards.get',
                'GET /cards': 'cards.list',
                'POST /cards/search': 'cards.find',

                'GET /decks/:id': 'decks.get',
                'GET /decks': 'decks.list',
                'POST /decks/search': 'decks.find',

                'GET /rooms': 'rooms.list',
                'POST /rooms/search': 'rooms.find',
                'POST /rooms': 'rooms.create',
                'PUT /rooms/join/players': 'rooms.join-players',
                'PUT /rooms/join/spectators': 'rooms.join-spectators',
                'PUT /rooms/leave': 'rooms.leave',
                'PUT /rooms/kick': 'rooms.kick',

                'PUT /games/start': 'games.start',
                'POST /games/cards': 'games.submit',
                'POST /games/winner': 'games.winner',
              },
              mappingPolicy: 'restrict',
              bodyParsers: {
                json: {
                  strict: false
                },
                urlencoded: {
                  extended: false
                }
              }
            }],
        },
        methods: {
          authorize: this.authorize
        },
        actions: {
          health: this.health
        }
      }
    );
  }

  /**
   * Verify and Decode the JWT token using the Seret.
   *
   * @private
   * @param {string} token
   * @returns {Promise<any>}
   * @memberof WebGatewayService
   */
  private verifyAndDecode(token: string): Promise<any> {
    return this.admin.auth().verifyIdToken(token);
  }

  /**
   * Authorize the request. Decode the User token and add it to the ctx meta.
   *
   * @private
   * @param {Context<any, any>} ctx
   * @param {string} route
   * @param {*} req
   * @returns
   * @memberof WebGatewayService
   */
  private authorize(ctx: Context<any, any>, route: string, req: any): Promise<Context<any, any>> {
    const auth = req.cookies['auth'] || req.headers['authorization'];
    if (auth === undefined || !auth?.length || !auth.startsWith('Bearer')) {
      return Promise.reject(new Errors.MoleculerError('No token found', 401, 'NO_TOKEN_FOUND'));
    }

    const token = auth.slice(7);
    return this.verifyAndDecode(token)
      .then(decoded => {
        ctx.meta.user = decoded;
        return ctx;
      })
      .catch(err => {
        throw new Errors.MoleculerError(`Denined access: ${err.message}`, 401, 'ACCESS_DENIED');
      });
  }

  /**
   * Get the health data for this service.
   *
   * @private
   * @param {Context} ctx
   * @returns {Promise<NodeHealthStatus>}
   * @memberof WebGatewayService
   */
  private health(ctx: Context): Promise<NodeHealthStatus> {
    return ctx.call('$node.health');
  }
}
