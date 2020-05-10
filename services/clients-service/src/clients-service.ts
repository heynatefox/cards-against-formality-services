import { Service, ServiceBroker, Context, NodeHealthStatus, Errors } from 'moleculer';
import admin from 'firebase-admin';
import dbMixin from '@cards-against-formality/db-mixin';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';

import serviceAccount from './auth.json';

/**
 * Interface that represents the Client object.
 *
 * @interface Client
 */
interface Client {
  _id: string;
  username: string;
  socket?: string;
  roomId?: string;
  disconnectedAt?: number;
}

/**
 * ClientsService registers users.
 *
 * @export
 * @class ClientsService
 * @extends {Service}
 */
export default class ClientsService extends Service {

  /**
   * Object used to communicate with the firebase authentication server.
   *
   * @private
   * @memberof ClientsService
   */
  private admin = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as any),
    databaseURL: 'https://cards-against-formality.firebaseio.com'
  });

  /**
   * Firestore database connection to store user information.
   *
   * @private
   * @memberof ClientsService
   */
  private firestoreDb = this.admin.firestore();

  /**
   * Validation schema for users.
   *
   * @private
   * @memberof ClientsService
   */
  private validationSchema = {
    _id: { type: 'string' },
    username: { type: 'string', pattern: '^[a-zA-Z0-9]+([_ -]?[a-zA-Z0-9])*$', min: 3, max: 12 },
    socket: { type: 'string', optional: true },
    roomId: { type: 'string', optional: true },
    disconnectedAt: { type: 'number', optional: true, default: null }
  };

  /**
   * Creates an instance of ClientsService.
   *
   * @param {ServiceBroker} _broker
   * @memberof ClientsService
   */
  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'clients',
        mixins: [
          dbMixin('clients'),
          CacheCleaner([
            'cache.cleaner.clients'
          ])
        ],
        settings: {
          entityValidator: this.validationSchema
        },
        actions: {
          'health': this.health,
          'renew': {
            handler: this.renew
          },
          'login': {
            params: {
              username: { optional: true, type: 'string' },
              uid: 'string',
              displayName: { optional: true, type: 'string' },
              photoURL: { optional: true, type: 'string' },
              email: { optional: true, type: 'string' },
              emailVerified: 'boolean',
              phoneNumber: { optional: true, type: 'number' },
              isAnonymous: 'boolean'
            },
            handler: this.login
          },
          'logout': this.logout,
          'check-username': {
            params: {
              username: 'string'
            },
            handler: this.checkUsername
          }
        },
        events: {
          'websocket-gateway.client.connected': this.onSocketConnection,
          'websocket-gateway.client.disconnected': this.onSocketDisconnect,
          'rooms.player.joined': this.onRoomJoin,
          'rooms.player.left': this.onRoomLeave,
          'rooms.spectator.joined': this.onRoomJoin,
          'rooms.spectator.left': this.onRoomLeave,
        },
        entityCreated: this.entityCreated,
        entityUpdated: this.entityUpdated,
        entityRemoved: this.entityRemoved
      },
    );
  }

  /**
   * Given a user object, convert all undefined values to null.
   *
   * @private
   * @template T
   * @param {T} object
   * @returns {T}
   * @memberof ClientsService
   */
  private sanitizeFirestoreInput<T>(object: T): T {
    const entries = Object.entries(object).map(([key, value]) => {
      if (value === undefined) {
        value = null;
      }
      return [key, value];
    });

    return Object.fromEntries(entries);
  }

  /**
   * Compare the given username against the regex.
   *
   * @private
   * @param {string} username
   * @returns {boolean}
   * @memberof ClientsService
   */
  private isUsernameValid(username: string): boolean {
    if (username.length < 3 || username.length > 12) {
      return false;
    }

    return /^[a-zA-Z0-9]+([_ -]?[a-zA-Z0-9])*$/.test(username);
  }

  /**
   * Check if the username passes the regex, and is not current taken.
   *
   * @private
   * @param {Context<{ username: string }>} ctx
   * @returns
   * @memberof ClientsService
   */
  private checkUsername(ctx: Context<{ username: string }>, isAnonymous?: boolean) {
    if (isAnonymous) {
      return Promise.resolve({ message: 'User is anonymous' });
    }

    const { username } = ctx.params;
    const isValid = this.isUsernameValid(username);
    if (!isValid) {
      return Promise.reject(new Errors.MoleculerError('Invalid username', 400, 'USERNAME_INVALID'));
    }

    return this.firestoreDb
      .collection('usernames')
      .doc(username)
      .get()
      .then(doc => {
        if (!doc.exists) {
          return { message: 'Username does not exist' };
        }
        throw new Errors.MoleculerError('Username already exists', 409, 'USERNAME_CONFLICT');
      });
  }

  /**
   * Create a user based on the given user object, and meta associated with
   * the request.
   *
   * @private
   * @param {Context<any, { user: any }>} ctx
   * @returns
   * @memberof ClientsService
   */
  private login(ctx: Context<any, { user: any }>) {
    if (ctx.params.isAnonymous) {
      // generate username...
      ctx.params.username = `Anon-${Math.round(Math.random() * 9999)}`;
    }

    const { username, displayName, photoURL, email, emailVerified, phoneNumber, isAnonymous } = ctx.params;
    const { uid } = ctx.meta.user;
    const data = { username, uid, displayName, photoURL, email, emailVerified, phoneNumber, isAnonymous };

    return this.checkUsername(ctx, isAnonymous)
      .then(() => {
        // username doesn't already exist. continue with signup.
        return this.firestoreDb
          .collection('users')
          .doc(data.uid)
          .set(this.sanitizeFirestoreInput(data));
      })
      .then(() => {
        // Don't add to the collection with a random anonymous username.
        if (isAnonymous) {
          return Promise.resolve() as any;
        }

        return this.firestoreDb
          .collection('usernames')
          .doc(username)
          .set({ uid: data.uid });
      })
      .then(() => ctx.call(
        `${this.name}.create`, { _id: data.uid, isAnonymous: data.isAnonymous, username: data.username }
      ));
  }

  /**
   * Remove the user associated with the logout call.
   *
   * @private
   * @param {Context<any, any>} ctx
   * @returns
   * @memberof ClientsService
   */
  private logout(ctx: Context<any, any>) {
    if (!ctx.meta.user?.uid) {
      return Promise.reject(new Error('Invalid user'));
    }

    return ctx.call(`${this.name}.remove`, { id: ctx.meta.user.uid });
  }

  /**
   * Try fetch the user making the request, from the firestore db.
   *
   * @private
   * @param {Context<any, { user: { uid: string } }>} ctx
   * @returns {Promise<Client>}
   * @memberof ClientsService
   */
  private async renew(ctx: Context<any, { user: { uid: string } }>): Promise<Client> {
    return this.firestoreDb
      .collection('users')
      .doc(ctx.meta.user.uid)
      .get()
      .then(doc => {
        if (doc.exists) {
          // try get the user from our cluster collection, if it doesn't exist create it.
          return ctx.call<any, any>(`${this.name}.get`, { id: ctx.meta.user.uid })
            .catch(() => {
              const data = doc.data();
              return ctx.call(
                `${this.name}.create`, { _id: data.uid, isAnonymous: data.isAnonymous, username: data.username }
              );
            });
        }
        // user doesn' exist in the firebase store...
        throw new Errors.MoleculerError('User doesnt exist', 404, 'USERNAME_NON_EXISTENT');
      });
  }

  /**
   * When a client joins a room, update the roomId to reflect the joined room.
   *
   * @private
   * @param {Context<{ clientId: string; roomId: string }>} ctx
   * @returns
   * @memberof ClientsService
   */
  private onRoomJoin(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    return ctx.call(`${this.name}.update`, { id: clientId, roomId })
      .catch(() => { this.logger.error('Unable to add client to room', { clientId, roomId }); });
  }

  /**
   * When a client leaves a room. Ensure the roomId is removed from the client.
   *
   * @private
   * @param {Context<{ clientId: string; roomId: string }>} ctx
   * @returns
   * @memberof ClientsService
   */
  private async onRoomLeave(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    const count = await ctx.call(`${this.name}.count`, { query: { _id: clientId, roomId } });
    if (count <= 0) {
      this.logger.warn('Client tried to leave a room its no longer in', { clientId, roomId });
      return;
    }

    return ctx.call(`${this.name}.update`, { id: clientId, roomId: null })
      .catch(() => { });
  }

  /**
   * Update the client with the registered socket id.
   *
   * @private
   * @param {Context<{ _id: string; socket: string }>} ctx
   * @returns {Promise<any>}
   * @memberof ClientsService
   */
  private onSocketConnection(ctx: Context<{ _id: string; socket: string }>): Promise<any> {
    const { _id, socket } = ctx.params;
    return ctx.call(`${this.name}.update`, { id: _id, socket, disconnectedAt: null })
      .catch(err => {
        this.logger.error(err);
      });
  }

  /**
   * Remove the client if the socket disconnects.
   *
   * @private
   * @param {Context<{ _id: string }>} ctx
   * @returns {Promise<any>}
   * @memberof ClientsService
   */
  private onSocketDisconnect(ctx: Context<{ _id: string }>): Promise<any> {
    const { _id } = ctx.params;
    return ctx.call(`${this.name}.remove`, { id: _id })
      .catch(() => { });
  }

  /**
   * Get the health data for this service.
   *
   * @private
   * @param {Context} ctx
   * @returns {Promise<NodeHealthStatus>}
   * @memberof ClientsService
   */
  private health(ctx: Context): Promise<NodeHealthStatus> {
    return ctx.call('$node.health');
  }

  /**
   * Emit an event when a Card is created.
   *
   * @private
   * @param {*} json
   * @param {Context} ctx
   * @returns
   * @memberof ClientsService
   */
  private entityCreated(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.created`, json);
  }

  /**
   * Emit an event when a card is updated.
   *
   * @private
   * @param {*} json
   * @param {Context} ctx
   * @returns
   * @memberof ClientsService
   */
  private entityUpdated(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.updated`, json);
  }

  /**
   * Emit an event when a Card is removed.
   *
   * @private
   * @param {*} json
   * @param {Context} ctx
   * @returns
   * @memberof ClientsService
   */
  private entityRemoved(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.removed`, json);
  }
}
