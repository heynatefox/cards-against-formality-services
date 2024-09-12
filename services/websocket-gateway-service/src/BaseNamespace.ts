import { Namespace, Socket } from 'socket.io';
import { ServiceBroker, LoggerInstance } from 'moleculer';
import { unauthorized } from 'boom';

/**
 * CustomSocket is an instance that extends the default Socket interface.
 * Containing user auth object.
 *
 * @export
 * @interface CustomSocket
 * @extends {Socket}
 */
export interface CustomSocket extends Socket {
  user?: {
    _id: string;
    username: string;
    socket?: string;
  };
}

/**
 * The BaseNamespace class implements the minimum amount of logic required for a namespace
 * to function.
 *
 * @export
 * @class BaseNamespace
 */
export default class BaseNamespace {
  /**
   * Creates an instance of BaseNamespace.
   *
   * @param {Namespace} namespace
   * @param {ServiceBroker} broker
   * @param {LoggerInstance} logger
   * @param {*} admin
   * @memberof BaseNamespace
   */
  constructor(
    protected namespace: Namespace,
    protected broker: ServiceBroker,
    protected logger: LoggerInstance,
    private admin: any
  ) { }

  /**
   * Force a client to join a given room.
   *
   * @protected
   * @param {string} clientId
   * @param {string} room
   * @returns {Promise<string>}
   * @memberof BaseNamespace
   */
  protected async joinRoom(clientId: string, room: string): Promise<string> {
    await this.namespace.in(clientId).socketsJoin(room);
    return `${clientId} joined room: ${room}`;
  }

  /**
   * Disconnect a given client.
   *
   * @protected
   * @param {string} clientId
   * @returns {Promise<string>}
   * @memberof BaseNamespace
   */
  protected async remoteDisconnect(clientId: string): Promise<string> {
    const oldClient = this.namespace.in(clientId);
    await oldClient.emit("Connected elsewhere.")
    await oldClient.disconnectSockets(true);
    return `${clientId} forcefully disconnected`;
  }

  /**
   * Decode the given auth token.
   *
   * @private
   * @param {string} token
   * @returns {Promise<any>}
   * @memberof BaseNamespace
   */
  private verifyAndDecode(token: string): Promise<any> {
    return this.admin.auth().verifyIdToken(token);
  }

  /**
   * Authorization middleware. Authorize users auth tokens on connection, and attach
   * relevant auth data to the users socket connection.
   *
   * @protected
   * @param {CustomSocket} client
   * @param {(err?: any) => void} next
   * @returns
   * @memberof BaseNamespace
   */
  protected async authMiddleware(client: CustomSocket, next: (err?: any) => void) {
    // Add it to the headers
    let token = client.handshake.query['auth'];
    if (!token?.length) {
      next(unauthorized('No token found'));
      return;
    }

    if (Array.isArray(token)) {
      token = token[0];
    }

    return this.verifyAndDecode(token)
      .then(user => {
        if (!user) {
          next(unauthorized('No Auth Token'));
          return;
        }
        client.user = user;
        client.user._id = user.uid;
        next();
      })
      .catch(err => {
        next(err);
      });
  }

  /**
   * Called on client connect.
   *
   * @protected
   * @param {CustomSocket} client
   * @memberof BaseNamespace
   */
  protected async onClientConnect(client: CustomSocket) {
    const _id = client.user._id;
    this.logger.info('Client Connected', client.id, 'to:', client.nsp.name);
    client.once('disconnect', () => this.onDisconnect(client));

    // Client might not exist. Try renew.
    const getOrRenew = async (): Promise<any> => {
      try {
        return await this.broker.call('clients.get', { id: _id });
      } catch {
        return await this.broker.call('clients.renew', {}, { meta: { user: client.user } });
      }
    };

    try {
      const user = await getOrRenew();
      // Update the user with the newly connected socket, before disconnecting previous. To reduce TTL.
      await this.broker.emit('websocket-gateway.client.connected', { _id, socket: client.id });
      if (user && user.socket && user.socket !== client.id) {
        this.logger.info('Disconnecting previous connection', user.socket, 'to:', client.nsp.name);
        // user already has a tab open. Forcefully disconnect it.
        return await this.remoteDisconnect(user.socket);
      }
      return null;
    } catch (err) {
      // Nothing.
    }
  }

  /**
   * Called on client disconnect.
   *
   * @protected
   * @param {CustomSocket} client
   * @memberof BaseNamespace
   */
  protected async onDisconnect(client: CustomSocket) {
    const time = new Date().getTime();
    client.removeAllListeners();

    const _id = client.user._id;
    await this.broker.call('clients.update', { id: _id, disconnectedAt: time })
      .then(() => {
        // TODO: Expand upon this, set should clean up timeouts on reconnect.
        // (this requires extra work as the client may connect to a different scaled instance)
        // disconnect time added to client.
        const timeout = 60 * 1000;
        setTimeout(async () => {
          await this.broker.call('clients.get', { id: _id })
            .then(async (user: any) => {
              const afterTimeoutTime = new Date().getTime();
              // If the user hasn't changed socketid or reconnected. Fire a disconnect event.
              // tslint:disable-next-line: max-line-length
              if (user.socket === client.id && user.disconnectedAt && (afterTimeoutTime - user.disconnectedAt) > (timeout - 10000)) {
                await this.broker.emit('websocket-gateway.client.disconnected', { _id });
              }
            })
            .catch(async () => await this.broker.emit('websocket-gateway.client.disconnected', { _id }));
        }, timeout);
      })
      // If error, client must have logged out.
      .catch(async () => {
        await this.broker.emit('websocket-gateway.client.disconnected', { _id });
      });
  }
}
