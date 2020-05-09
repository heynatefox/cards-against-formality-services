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
    this.broker.call('clients.update', { id: _id, disconnectedAt: time })
      .then(() => {
        // TODO: Expand upon this, set should clean up timeouts on reconnect.
        // (this requires extra work as the client may connect to a different scaled instance)
        // disconnect time added to client.
        const timeout = 60 * 1000;
        setTimeout(async () => {
          this.broker.call('clients.get', { id: _id })
            .then((user: any) => {
              const afterTimeoutTime = new Date().getTime();
              // If the user hasn't changed socketid or reconnected. Fire a disconnect event.
              // tslint:disable-next-line: max-line-length
              if (user.socket === client.id && user.disconnectedAt && afterTimeoutTime - user.disconnectedAt > (timeout - 5000)) {
                this.broker.emit('websocket-gateway.client.disconnected', { _id });
              }
            })
            .catch(() => this.broker.emit('websocket-gateway.client.disconnected', { _id }));
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

    this.broker.call('clients.get', { id: _id })
      // catch, client might not exist.
      .catch((err) => null)
      .then(async (user: any) => {
        // Update the user with the newly connected socket, before disconnecting previous. To reduce TTL.
        await this.broker.emit('websocket-gateway.client.connected', { _id, socket: client.id });
        if (user && user.socket && user.socket !== client.id) {
          // user already has a tab open. Forcefully disconnect it.
          return this.remoteDisconnect(user.socket);
        }
        return null;
      })
      // previous socket may not have been able to be disconnected. user may have closed the tab
      .catch((err) => null);
  }
}
