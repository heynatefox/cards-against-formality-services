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

  protected onDisconnect(client: CustomSocket): void {
    const time = new Date().getTime();
    super.onDisconnect(client);

    const _id = client.user._id;
    const timeout = 60 * 1000;
    this.broker.call('clients.update', { id: _id, disconnectedAt: time })
      .then(() => {
        // TODO: Expand upon this, set should clean up timeouts on reconnect.
        // (this requires extra work as the client may connect to a different scaled instance)
        // disconnect time added to client.
        setTimeout(async () => {
          const user = await this.broker.call('clients.get', { id: _id }) as any;
          const afterTimeoutTime = new Date().getTime();
          // If the user hasn't reconnected. Fire a disconnect event.
          if (user.disconnectedAt && afterTimeoutTime - user.disconnectedAt > timeout) {
            this.broker.emit('websocket-gateway.client.disconnected', { _id });
          }
        }, timeout);
      })
      // If error, client must have logged out.
      .catch(() => {
        this.broker.emit('websocket-gateway.client.disconnected', { _id });
      });

  }

  protected async onClientConnect(client: CustomSocket) {
    const _id = client.user._id;
    this.logger.info('Client Connected', client.id, 'to:', client.nsp.name);
    client.once('disconnect', () => this.onDisconnect(client));

    this.broker.emit('websocket-gateway.client.connected', { _id, socket: client.id });
  }
}
