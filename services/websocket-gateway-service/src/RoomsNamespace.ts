import { Namespace } from 'socket.io';
import { ServiceBroker, LoggerInstance } from 'moleculer';

import BaseNamespace from './BaseNamespace';

/**
 * The RoomNamespace class handles the connectivity of users within a Room.
 *
 * @export
 * @class RoomsNamespace
 * @extends {BaseNamespace}
 */
export default class RoomsNamespace extends BaseNamespace {

  /**
   * Creates an instance of RoomsNamespace.
   *
   * @param {Namespace} namespace
   * @param {ServiceBroker} broker
   * @param {LoggerInstance} logger
   * @param {*} admin
   * @memberof RoomsNamespace
   */
  constructor(namespace: Namespace, broker: ServiceBroker, logger: LoggerInstance, admin: any) {
    super(namespace, broker, logger, admin);

    namespace
      .use((client, next) => super.authMiddleware(client, next))
      .on('connection', (client) => { this.onClientConnect(client); })
      .on('error', (err) => { this.logger.error(err); });
  }
}
