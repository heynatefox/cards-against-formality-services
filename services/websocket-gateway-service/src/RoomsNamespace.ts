import { Namespace } from 'socket.io';
import { ServiceBroker, LoggerInstance } from 'moleculer';

import BaseNamespace from './BaseNamespace';

export default class RoomsNamespace extends BaseNamespace {

  constructor(namespace: Namespace, broker: ServiceBroker, logger: LoggerInstance) {
    super(namespace, broker, logger);

    namespace
      .use((client, next) => super.authMiddleware(client, next))
      .on('connection', (client) => { this.onClientConnect(client); })
      .on('error', (err) => { this.logger.error(err); });
  }
}
