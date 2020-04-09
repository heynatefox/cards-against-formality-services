import { Namespace, Socket, Adapter } from 'socket.io';
import { ServiceBroker, LoggerInstance, Errors } from 'moleculer';
import { verify } from 'jsonwebtoken';
import { unauthorized } from 'boom';

export interface CustomSocket extends Socket {
  user?: {
    _id: string;
    username: string;
    socket?: string;
  };
}

export interface RedisAdapter extends Adapter {
  clients: (callback: (error: Error, clients: string[]) => void) => void;
  clientRooms: (id: string, callback: (error: Error, rooms: string[]) => void) => void;
  remoteJoin: (id: string, room: string, callback: (error: Error) => void) => void;
}

export default class BaseNamespace {

  protected adapter: RedisAdapter = this.namespace.adapter as any;

  constructor(protected namespace: Namespace, protected broker: ServiceBroker, protected logger: LoggerInstance) {
  }

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

  private verifyAndDecode(token: string): Promise<any> {
    return new Promise((resolve, reject) => {
      verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(decoded);
        return;
      });
    });
  }

  protected async authMiddleware(client: CustomSocket, next: (err?: any) => void) {
    // Add it to the headers
    const token = client.handshake.query['auth'];
    this.logger.info(client.handshake.query);
    if (!token?.length) {
      next(unauthorized('No token found'));
      return;
    }

    return this.verifyAndDecode(token)
      .then(user => {
        if (!user) {
          next(unauthorized('No Auth Token'));
          return;
        }
        client.user = user;
        next();
      })
      .catch(err => {
        next(err);
      });
  }

  protected onClientConnect(client: CustomSocket) {
    this.logger.info('Client Connected', client.id, 'to:', client.nsp.name);
    client.once('disconnect', () => this.onDisconnect(client));
  }

  private onDisconnect(client: CustomSocket) {
    client.emit('disconnect', 'Socket Disconnected');
    client.leaveAll();
    client.removeAllListeners();
  }
}
