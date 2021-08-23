import { Namespace, Socket } from 'socket.io';
import { Adapter } from 'socket.io-adapter';
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
 * RedisAdapter is an interface that extends the default socket io adapter.
 * Exposing functions to allow cross instance client control.
 *
 * @export
 * @interface RedisAdapter
 * @extends {Adapter}
 */
export interface RedisAdapter extends Adapter {
  clients: (callback: (error: Error, clients: string[]) => void) => void;
  clientRooms: (id: string, callback: (error: Error, rooms: string[]) => void) => void;
  remoteJoin: (id: string, room: string, callback: (error: Error) => void) => void;
  remoteDisconnect: (id: string, close: boolean, callback: (error: Error) => void) => void;
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
   * Socket.io Redis adapter for scaling between multiple instances.
   *
   * @protected
   * @type {RedisAdapter}
   * @memberof BaseNamespace
   */
  protected adapter: RedisAdapter = this.namespace.adapter as any;

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
  protected joinRoom(clientId: string, room: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.adapter.remoteJoin(clientId, room, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(`${clientId} joined room: ${room}`);
        }
      });
    });
  }

  /**
   * Disconnect a given client.
   *
   * @protected
   * @param {string} clientId
   * @returns {Promise<string>}
   * @memberof BaseNamespace
   */
  protected remoteDisconnect(clientId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.adapter.remoteDisconnect(clientId, true, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(`${clientId} forcefully disconnected`);
        }
      });
    });
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
  protected onClientConnect(client: CustomSocket) {
    this.logger.info('Client Connected', client.id, 'to:', client.nsp.name);
    client.once('disconnect', () => this.onDisconnect(client));
  }

  /**
   * Called on client disconnect.
   *
   * @protected
   * @param {CustomSocket} client
   * @memberof BaseNamespace
   */
  protected onDisconnect(client: CustomSocket) {
    client.removeAllListeners();
  }
}
