import compression from 'compression';
import cookieParser from 'cookie-parser';
import ApiGateway from 'moleculer-web';
import { Service, Errors, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import { verify } from 'jsonwebtoken';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';

/**
 * AdminGatewayService exposes all access to admin users.
 *
 * @export
 * @class AdminGatewayService
 * @extends {Service}
 */
export default class AdminGatewayService extends Service {

  /**
   * Creates an instance of AdminGatewayService.
   *
   * @param {ServiceBroker} _broker
   * @memberof AdminGatewayService
   */
  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'admin-gateway',
        mixins: [
          ApiGateway,
          CacheCleaner([
            'cache.clean.cards',
            'cache.clean.decks',
            'cache.clean.clients',
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
            credentials: false,
            maxAge: 3600
          },
          use: [
            compression(),
            cookieParser()
          ],
          routes: [
            {
              path: '/admin',
              // Enable in prod.
              authorization: false,
              aliases: {
                'GET /web/health': 'web-gateway.health',
                'GET /gateway/health': 'admin-gateway.health',

                'GET /cards/health': 'cards.health',
                'GET /cards/:id': 'cards.get',
                'GET /cards': 'cards.list',
                'POST /cards/search': 'cards.find',
                'POST /cards': 'cards.create',
                'PATCH /cards/:id': 'cards.update',
                'DELETE /cards/:id': 'cards.remove',

                'GET /decks/health': 'decks.health',
                'GET /decks/:id': 'decks.get',
                'GET /decks': 'decks.list',
                'POST /decks/search': 'decks.find',
                'POST /decks': 'decks.create',
                'PATCH /decks/:id': 'decks.update',
                'DELETE /decks/:id': 'decks.remove',

                'GET /clients/health': 'clients.health',
                'GET /clients/:id': 'clients.get',
                'GET /clients': 'clients.list',
                'POST /clients/search': 'clients.find',
                'POST /clients': 'clients.create',
                'PATCH /clients/:id': 'clients.update',
                'DELETE /clients/:id': 'clients.remove',

                'GET /rooms/health': 'rooms.health',
                'GET /rooms/:id': 'rooms.get',
                'GET /rooms': 'rooms.list',
                'POST /rooms/search': 'rooms.find',
                'POST /rooms': 'rooms.create',
                'PATCH /rooms/:id': 'rooms.update',
                'DELETE /rooms/:id': 'rooms.remove',
                'PUT /rooms/join/players': 'rooms.join-players',
                'PUT /rooms/join/spectators': 'rooms.join-spectators',
                'PUT /rooms/leave': 'rooms.leave',

                'GET /games/health': 'games.health',
                'PUT /games/start': 'games.start',
                'POST /games/cards': 'games.submit',
                'POST /games/winner': 'games.winner',
                'GET /games/:id': 'games.get',
                'GET /games': 'games.list',
                'POST /games/search': 'games.find',
                'POST /games': 'games.create',
                'PATCH /games/:id': 'games.update',
                'DELETE /games/:id': 'games.remove',
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
   * @memberof AdminGatewayService
   */
  private verifyAndDecode(token: string): Promise<any> {
    return new Promise((resolve, reject) => {
      verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(decoded);
        return;
      });
    });
  }

  /**
   * Authorize the request. Decode the User token and add it to the ctx meta.
   *
   * @private
   * @param {Context<any, any>} ctx
   * @param {string} route
   * @param {*} req
   * @param {*} res
   * @returns
   * @memberof AdminGatewayService
   */
  private authorize(ctx: Context<any, any>, route: string, req: any, res: any) {
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
   * @memberof AdminGatewayService
   */
  private health(ctx: Context): Promise<NodeHealthStatus> {
    this.logger.info('')
    return ctx.call('$node.health');
  }
}
