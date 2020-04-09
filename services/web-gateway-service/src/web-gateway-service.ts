import compression from 'compression';
import cookieParser from 'cookie-parser';
import ApiGateway from 'moleculer-web';
import { Service, ServiceBroker, Context, NodeHealthStatus, Errors } from 'moleculer';
import { verify } from 'jsonwebtoken';

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
            origin: 'http://localhost:3000',
            methods: ['GET', 'OPTIONS', 'POST', 'PATCH', 'DELETE'],
            allowedHeaders: ['Authorization'],
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
              path: '/api/login',
              aliases: {
                'POST /': this.handleLogin,
                'GET /renew': this.handleRenew
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
            },
            {
              path: '/api',
              authorization: true,
              aliases: {
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
   * Helper method to correctly format a response from a login or renew auth request.
   *
   * @private
   * @param {*} res
   * @param {*} _err
   * @returns
   * @memberof WebGatewayService
   */
  private handleAuthError(res: any, _err: any) {
    let err = _err?.message?.payload ? _err.message.payload : _err;
    let statusCode = err.statusCode || err.code;

    // If this happens an unexpected internal server error has happened.
    if (!statusCode) {
      statusCode = 500;
      this.logger.error(_err);
      err = { message: 'Something went wrong...' };
    }

    if (!err?.message?.length) {
      err.messge = 'Something went wrong...';
    }

    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify(err));
    res.end();
    return null;
  }

  /**
   * Attempt to renew the jwt token.
   *
   * @private
   * @param {*} req
   * @param {*} res
   * @returns
   * @memberof WebGatewayService
   */
  private handleRenew(req: any, res: any) {
    return this.authorize(req.$ctx, undefined, req)
      .then(ctx => this.handleClientAuth(ctx, 'renew', req, res))
      .catch(_err => this.handleAuthError(res, _err));
  }

  /**
   * Login.
   *
   * @private
   * @param {*} req
   * @param {*} res
   * @returns
   * @memberof WebGatewayService
   */
  private handleLogin(req: any, res: any) {
    return this.handleClientAuth(req.$ctx, 'login', req, res)
      .catch(_err => this.handleAuthError(res, _err));
  }

  /**
   * Handle setting the correct headers with the generated jwt token.
   *
   * @private
   * @param {Context<any, any>} ctx
   * @param {string} authRoute
   * @param {*} req
   * @param {*} res
   * @returns {Promise<any>}
   * @memberof WebGatewayService
   */
  private handleClientAuth(ctx: Context<any, any>, authRoute: string, req: any, res: any): Promise<any> {
    return ctx.call(`clients.${authRoute}`, req.$params)
      .then(data => {
        const daysToExpire = 0.25;
        const date = new Date();
        date.setDate(date.getDate() + daysToExpire);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `auth=${ctx.meta.token}; HttpOnly; Expires=${date.toUTCString()}`
        });
        res.write(JSON.stringify(data));
        res.end();
        return null;
      });
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
