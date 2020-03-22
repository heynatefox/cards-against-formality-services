import compression from 'compression';
import ApiGateway from 'moleculer-web';
import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import { verify } from 'jsonwebtoken';
import { unauthorized } from 'boom';

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
          ApiGateway
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
            compression()
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
                'PATCH /cards/:id': 'cards.update',
                'DELETE /cards/:id': 'cards.remove'
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
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer')) {
      return Promise.reject(unauthorized('No token found'));
    }

    const token = auth.slice(7);
    return this.verifyAndDecode(token)
      .then(decoded => {
        ctx.meta.user = decoded;
        return ctx;
      })
      .catch(err => {
        this.logger.error(err);
        unauthorized('Invalid token. Insufficient privileges');
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
    return ctx.call('$node.health');
  }
}
