import { Service, ServiceBroker, Context, NodeHealthStatus, Errors } from 'moleculer';
import { conflict, forbidden } from 'boom';
import dbMixin from '@cards-against-formality/db-mixin';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';

/**
 * Status is an enumerated value to indicate the status of the room.
 *
 * @enum {number}
 */
enum Status {
  PENDING = 'pending',
  STARTED = 'started',
  FINISHED = 'finished'
}

/**
 * Room Options is an interface that represents the options in a room object.
 *
 * @interface RoomOptions
 */
interface RoomOptions {
  decks: string[];
  target: number;
  maxPlayers: number;
}

/**
 * Room is an interface dictates the shape of the Room.
 *
 * @interface Room
 */
interface Room {
  _id: string;
  host: string;
  players: string[];
  spectators: string[];
  name: string;
  status: Status;
  options: RoomOptions;
  passcode?: string;
}

/**
 * RoomService handles creating rooms and handling the players within.
 *
 * @export
 * @class RoomsService
 * @extends {Service}
 */
export default class RoomsService extends Service {

  /**
   * Validation Schema for a Room.
   *
   * @private
   * @memberof RoomsService
   */
  private validationSchema = {
    host: 'string',
    players: { type: 'array', items: 'string', default: [] },
    spectators: { type: 'array', items: 'string', default: [] },
    name: { type: 'string', pattern: '^[a-zA-Z0-9]+([_ -]?[a-zA-Z0-9])*$', min: 2, max: 16 },
    status: { type: 'enum', values: ['pending', 'started', 'finished'], default: 'pending' },
    options: {
      type: 'object', strict: true, props: {
        decks: { type: 'array', items: 'string', min: 1 },
        target: { type: 'number', min: 5, max: 100, default: 10 },
        maxPlayers: { type: 'number', default: 10, min: 2, max: 50 },
        maxSpectators: { type: 'number', default: 10, min: 1, max: 50 },
        roundTime: { type: 'number', default: 60, min: 15, max: 60 }
      },
    },
    passcode: { type: 'string', pattern: '^[a-zA-Z0-9]+([_ -]?[a-zA-Z0-9])*$', min: 4, max: 12, optional: true },
  };

  /**
   * Creates an instance of RoomsService.
   *
   * @param {ServiceBroker} _broker
   * @memberof RoomsService
   */
  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'rooms',
        mixins: [
          dbMixin('rooms'),
          CacheCleaner([
            'cache.clean.rooms',
            'cache.clean.clients'
          ])
        ],
        settings: {
          entityValidator: this.validationSchema,
          populates: {
            players: {
              action: 'clients.get',
              params: {
                fields: ['username', '_id']
              }
            },
            spectators: {
              action: 'clients.get',
              params: {
                fields: ['username', '_id']
              }
            },
          }
        },
        hooks: {
          before: {
            create: [this.beforeCreate] as any
          },
          after: {
            'get': [this.afterGet] as any,
            'list': [this.afterList] as any,
            'find': [this.afterFind] as any,
            'join-players': [this.afterAddPlayer] as any,
            'join-spectators': [this.afterAddPlayer] as any,
            'leave': [this.afterRemovePlayer] as any,
            'kick': [this.afterKickPlayer] as any
          }
        },
        actions: {
          'health': this.health,
          'join-players': {
            params: {
              roomId: 'string',
              clientId: 'string',
            },
            handler: ctx => this.addPlayer(ctx, 'players')
          },
          'join-spectators': {
            params: {
              roomId: 'string',
              clientId: 'string',
            },
            handler: ctx => this.addPlayer(ctx, 'spectators')
          },
          'leave': {
            params: {
              roomId: 'string',
              clientId: { optional: true, type: 'string' },
            },
            handler: this.removePlayer
          },
          'kick': {
            params: {
              roomId: 'string',
              clientId: 'string',
            },
            handler: this.kickPlayer
          },
        },
        events: {
          'clients.removed': this.removeClient
        },
        entityCreated: this.entityCreated,
        entityUpdated: this.entityUpdated,
        entityRemoved: this.entityRemoved,
      },
    );
  }

  /**
   * Obfuscate password on the way out.
   *
   * @private
   * @param {Context<Room, { internal: boolean }>} ctx
   * @param {Room} res
   * @returns
   * @memberof RoomsService
   */
  private afterGet(ctx: Context<Room, { internal: boolean }>, res: Room) {
    if (ctx.meta.internal) {
      return res;
    }

    if (res.passcode) {
      (res as any).passcode = true;
    }
    return res;
  }

  /**
   * Obfuscate password on the way out.
   *
   * @private
   * @param {Context<Room, { internal: boolean }>} ctx
   * @param {{ rows: Room[] }} res
   * @returns
   * @memberof RoomsService
   */
  private afterList(ctx: Context<Room, { internal: boolean }>, res: { rows: Room[] }) {
    if (ctx.meta.internal) {
      return res;
    }

    res.rows.forEach(row => {
      if (row.passcode) {
        (row as any).passcode = true;
      }
    });
    return res;
  }

  /**
   * Obfuscate password on the way out.
   *
   * @private
   * @param {Context<Room, { internal: boolean }>} ctx
   * @param {Room[]} res
   * @returns
   * @memberof RoomsService
   */
  private afterFind(ctx: Context<Room, { internal: boolean }>, res: Room[]) {
    if (ctx.meta.internal) {
      return res;
    }

    return res.map(room => {
      if (room.passcode) {
        (room as any).passcode = true;
      }
      return room;
    });
  }

  /**
   * After a Player is added to a room. Emit an event that a Player has joined, and populate the arrays.
   *
   * @private
   * @param {Context<{ clientId: string; roomId: string }>} ctx
   * @param {Room} res
   * @returns
   * @memberof RoomsService
   */
  private async afterAddPlayer(ctx: Context<{ clientId: string; roomId: string }>, res: Room) {
    const { clientId, roomId } = ctx.params;
    const prop = ctx.action.name === 'rooms.join-players' ? 'player' : 'spectator';
    await ctx.emit(`${this.name}.${prop}.joined`, { clientId, roomId });
    return ctx.call(`${this.name}.get`, { id: roomId, populate: ['players', 'spectators'] });
  }

  /**
   * After a Player has left the room, emit a player left event.
   *
   * @private
   * @param {Context<{ clientId: string; roomId: string }>} ctx
   * @param {Room} res
   * @returns
   * @memberof RoomsService
   */
  private async afterRemovePlayer(ctx: Context<{ roomId: string }, any>, res: Room) {
    const { roomId } = ctx.params;
    const clientId = ctx.meta.user.uid;
    await ctx.emit(`${this.name}.player.left`, { clientId, roomId });
    return res;
  }

  /**
   * After a Player has been kicked, emit a left and kicked event onto the bus.
   *
   * @private
   * @param {Context<{ roomId: string; clientId: string }, any>} ctx
   * @param {Room} res
   * @returns
   * @memberof RoomsService
   */
  private async afterKickPlayer(ctx: Context<{ roomId: string; clientId: string }, any>, res: Room) {
    const { roomId, clientId } = ctx.params;
    await ctx.emit(`${this.name}.player.left`, { clientId, roomId });
    await ctx.emit(`${this.name}.player.kicked`, { clientId, roomId });
    return res;
  }

  /**
   * Check to see if a Room with the given name already exists, before creating it.
   *
   * @private
   * @param {Context<Room>} ctx
   * @returns {Promise<Context<Room, any>>}
   * @memberof RoomsService
   */
  private async beforeCreate(ctx: Context<Room, any>): Promise<Context<Room, any>> {
    const count = await ctx.call(`${this.name}.count`, { query: { name: ctx.params.name } });
    if (count > 0) {
      throw conflict('A room with that name already exists');
    }

    const host = ctx.meta.user.uid;
    ctx.params.players = [host];
    ctx.params.host = host;
    return ctx;
  }

  /**
   * Given an _id for the room and client, remove the client from spectators and players.
   *
   * @private
   * @param {Context<{ roomId: string; clientId: string }>} ctx
   * @returns {Promise<Room>}
   * @memberof RoomsService
   */
  private removePlayer(ctx: Context<{ roomId: string; clientId?: string }, { user?: { uid: string } }>): Promise<Room> {
    const { roomId, } = ctx.params;
    const clientId = ctx.meta.user.uid;

    return this.adapter.updateById(roomId, { $pull: { players: clientId, spectators: clientId } })
      .then(json => this.entityChanged('updated', json, ctx).then(() => json));
  }

  /**
   * Kick the user from the given room. Ensure the person performing the kick action is host.
   *
   * @private
   * @param {Context<{ roomId: string; clientId: string }, { user?: { uid: string } }>} ctx
   * @returns {Promise<Room>}
   * @memberof RoomsService
   */
  private async kickPlayer(
    ctx: Context<{ roomId: string; clientId: string }, { user?: { uid: string } }>
  ): Promise<Room> {

    const { roomId, clientId } = ctx.params;
    const host = ctx.meta.user.uid;

    const room = await ctx.call(`${this.name}.get`, { id: roomId }) as Room;
    if (room.host !== host) {
      return Promise.reject(new Error('Only the host can kick players.'));
    }

    return this.adapter.updateById(roomId, { $pull: { players: clientId, spectators: clientId } })
      .then(json => this.entityChanged('updated', json, ctx).then(() => json));
  }

  /**
   * Given an _id for the room and client, add the client to the defined array.
   *
   * @private
   * @param {Context<{ roomId: string; clientId: string }>} ctx
   * @param {string} arrayProp
   * @returns {Promise<Room>}
   * @memberof RoomsService
   */
  private async addPlayer(ctx: Context<{ roomId: string; clientId: string; passcode?: string }>, arrayProp: string)
    : Promise<Room> {

    const { roomId, clientId, passcode } = ctx.params;

    const room = await ctx.call<Room, any>(
      `${this.name}.get`, { id: roomId, }, { meta: { internal: true } }
    );
    const user: any = await ctx.call(`clients.get`, { id: clientId });

    // check if the user is in a room.
    if (user?.roomId?.length) {
      if (user.roomId === roomId) {
        // user is already in this room.
        return Promise.resolve(room);
      } else {
        // user must be in another room.
        throw forbidden('You are already in a game.');
      }
    }

    // If the room is passcode protected. Try authorize.
    if (room.passcode && room.passcode !== passcode) {
      return Promise.reject(new Errors.MoleculerError('Invalid password', 401, 'PASSWORD_INVALID'));
    }

    // Check whether this client would surpass the max number of players.
    if (room.players.length + 1 > room.options.maxPlayers) {
      throw forbidden('The room you are trying to join is full');
    }

    return this.adapter.updateById(roomId, { $addToSet: { [arrayProp]: clientId } })
      .then(json => this.entityChanged('updated', json, ctx).then(() => json));
  }

  /**
   * Given the _id of the disconnected client. Try remove it from a room if it's in one.
   *
   * @private
   * @param {Context<{ _id: string }>} ctx
   * @returns {Promise<Room>}
   * @memberof RoomsService
   */
  private removeClient(ctx: Context<{ _id: string }>): Promise<Room> {
    const { _id } = ctx.params;
    return this.adapter.collection.findOneAndUpdate(
      { $or: [{ players: _id }, { spectators: _id }] },
      { $pull: { players: _id, spectators: _id } },
      { returnOriginal: false }
    )
      .then(async doc => {
        // Client is not in any rooms
        if (!doc.value) {
          return null;
        }
        await ctx.emit(`${this.name}.player.left`, { clientId: _id, roomId: doc.value?._id });
        return this.entityChanged('updated', doc.value, ctx).then(() => doc.value);
      });
  }

  /**
   * Get the health data for this service.
   *
   * @private
   * @param {Context} ctx
   * @returns {Promise<NodeHealthStatus>}
   * @memberof RoomsService
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
   * @memberof RoomsService
   */
  private entityCreated(json: any, ctx: Context) {
    if (json.passcode) {
      json.passcode = true;
    }
    return ctx.emit(`${this.name}.created`, json);
  }

  /**
   * Emit an event when a card is updated.
   *
   * @private
   * @param {*} json
   * @param {Context} ctx
   * @returns
   * @memberof RoomsService
   */
  private async entityUpdated(json: Room, ctx: Context) {
    if (json.passcode) {
      (json as any).passcode = true;
    }

    // If all players have left. OR the room status is still pending, and the host leaves. Destroy the room.
    if (!json.players?.length || (json.status === Status.PENDING && !json.players?.includes(json.host))) {
      // Everyone has left. Destroy the room.
      try {
        await ctx.call(`${this.name}.remove`, { id: json._id });
        return;
      } catch (e) {
        this.logger.error(e);
      }
    }
    ctx.emit(`${this.name}.updated`, json);
  }

  /**
   * Emit an event when a Card is removed.
   *
   * @private
   * @param {*} json
   * @param {Context} ctx
   * @returns
   * @memberof RoomsService
   */
  private async entityRemoved(json: any, ctx: Context) {
    if (json.passcode) {
      json.passcode = true;
    }
    await ctx.emit(`${this.name}.removed`, json);
    if (json?.players?.length) {

      // Ensure the roomId is removed from each of the clients.
      for (const player of json.players) {
        await ctx.emit(`${this.name}.player.left`, { clientId: player, roomId: json._id });
      }

      for (const spectator of json.spectators) {
        await ctx.emit(`${this.name}.spectator.left`, { clientId: spectator, roomId: json._id });
      }
    }
  }
}
