import { Namespace } from 'socket.io';
import { ServiceBroker, LoggerInstance } from 'moleculer';

import BaseNamespace, { CustomSocket } from './BaseNamespace';

export default class GameNamespace extends BaseNamespace {

  constructor(namespace: Namespace, broker: ServiceBroker, logger: LoggerInstance, admin: any) {
    super(namespace, broker, logger, admin);

    namespace
      .use((client, next) => super.authMiddleware(client, next))
      .on('connection', (client) => { this.onClientConnect(client); })
      .on('error', (err) => { this.logger.error(err); });
  }

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
