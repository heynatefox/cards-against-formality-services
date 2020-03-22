import compression from 'compression';
import ApiGateway from 'moleculer-web';
import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';

/**
 * WebGatewayService acts as the core gateway to access any of the internal services.
 *
 * @export
 * @class WebGatewayService
 * @extends {Service}
 */
export default class WebGatewayService extends Service {

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
              path: '/api',
              authorization: false,
              aliases: {
                'POST /login': this.handleLogin,

                'GET /cards/:id': 'cards.get',
                'GET /cards': 'cards.list',
                'POST /cards/search': 'cards.find',
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
        actions: {
          health: this.health
        }
      }
    );
  }

  /**
   * Handle setting the correct headers with the generated jwt token.
   *
   * @private
   * @param {*} req
   * @param {*} res
   * @returns {Promise<any>}
   * @memberof WebGatewayService
   */
  private handleLogin(req: any, res: any): Promise<any> {
    return req.$ctx.call('clients.login', req.$params)
      .then(msg => {
        const daysToExpire = 0.25;
        const date = new Date();
        date.setDate(date.getDate() + daysToExpire);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `auth=${req.$ctx.meta.token}; Expires=${date.toUTCString()}`
        });
        res.write(JSON.stringify(msg));
        res.end();
        return null;
      })
      .catch(_err => {
        const err = _err?.message?.payload ? _err.message.payload : _err;
        res.writeHead(err.statusCode || err.code, { 'Content-Type': 'application/json' });
        res.write(JSON.stringify(err));
        res.end();
        return null;
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
