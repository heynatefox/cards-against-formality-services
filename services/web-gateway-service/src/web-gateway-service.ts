import compression from 'compression';
import ApiGateway from 'moleculer-web';
import { Service, ServiceBroker } from 'moleculer';

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
        }
      }
    );
  }
}
