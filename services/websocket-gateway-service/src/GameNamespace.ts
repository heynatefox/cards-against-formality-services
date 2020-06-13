import { Namespace } from 'socket.io';
import { ServiceBroker, LoggerInstance } from 'moleculer';

import BaseNamespace, { CustomSocket } from './BaseNamespace';

/**
 * The GameNamespace class controls users connecting to a game.
 *
 * @export
 * @class GameNamespace
 * @extends {BaseNamespace}
 */
export default class GameNamespace extends BaseNamespace {

  /**
   * Creates an instance of GameNamespace.
   *
   * @param {Namespace} namespace
   * @param {ServiceBroker} broker
   * @param {LoggerInstance} logger
   * @param {*} admin
   * @memberof GameNamespace
   */
  constructor(namespace: Namespace, broker: ServiceBroker, logger: LoggerInstance, admin: any) {
    super(namespace, broker, logger, admin);

    namespace
      .use((client, next) => super.authMiddleware(client, next))
      .on('connection', (client) => { this.onClientConnect(client); })
      .on('error', (err) => { this.logger.error(err); });
  }

  /**
   * Handles what happens when a user connects to a game.
   *
   * @protected
   * @param {CustomSocket} client
   * @returns
   * @memberof GameNamespace
   */
  protected async onClientConnect(client: CustomSocket) {
    return this.broker.call('clients.get', { id: client.user._id })
      .then((user: any) => this.joinRoom(client.id, user.roomId))
      .then((res) => {
        super.onClientConnect(client);
        this.logger.info(res);
        return null;
      })
      .catch(err => {
        this.logger.error(err);
        // Disconnect the client. Failed to add it to the room.
        this.onDisconnect(client);
      });
  }
}
