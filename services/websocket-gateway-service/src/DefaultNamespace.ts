import { Namespace, Socket } from 'socket.io';
import { ServiceBroker, LoggerInstance } from 'moleculer';

import BaseNamespace, { CustomSocket } from './BaseNamespace';

export default class DefaultNamespace extends BaseNamespace {

  constructor(namespace: Namespace, broker: ServiceBroker, logger: LoggerInstance, admin: any) {
    super(namespace, broker, logger, admin);

    namespace
      .use((client, next) => super.authMiddleware(client, next))
      .on('connection', (client) => { this.onClientConnect(client); })
      .on('error', (err) => { this.logger.error(err); });
  }

  protected async onClientConnect(client: CustomSocket) {
    const _id = client.user._id;
    super.onClientConnect(client);

    this.broker.emit('websocket-gateway.client.connected', { _id, socket: client.id });
  }
}
