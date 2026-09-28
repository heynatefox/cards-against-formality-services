import { Service, ServiceBroker, ServiceSchema, Context, NodeHealthStatus, Errors } from 'moleculer';
import { ObjectId } from 'mongodb';
import { forbidden } from 'boom';
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
        roundTime: { type: 'number', default: 60, min: 15, max: 60 },
        // House rule: a virtual player submits a random card each round
        randoCardrissian: { type: 'boolean', optional: true, default: false },
        // House rule: draw an extra white card on 2+ pick prompts
        packingHeat: { type: 'boolean', optional: true, default: false },
        // House rule: pay one point to swap your whole hand
        rebootingUniverse: { type: 'boolean', optional: true, default: false },
        // Solo: three probe bots fill the seats and the human always judges.
        // The games service reads this to bypass the two-player minimum.
        soloMode: { type: 'boolean', optional: true, default: false }
      },
    },
    // Any 4-12 visible characters. This used to be alphanumeric with single
    // separators, which rejected the passwords people actually type ("pizza!")
    // and read to them as the room being broken, not the password being picky.
    passcode: { type: 'string', pattern: '^\\S{4,12}$', min: 4, max: 12, optional: true },
    // Epoch ms, set server-side on create. Lets cleanup jobs age rooms out
    // (target policy: empty rooms live for 24h) and lets clients sort by age.
    createdAt: { type: 'number', optional: true },
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
            create: [this.beforeCreate] as any,
            list: [this.beforeList] as any,
            'join-players': [this.confirmUserAction] as any,
            'join-spectators': [this.confirmUserAction] as any
          },
          after: {
            'get': [this.afterGet] as any,
            'list': [this.afterList] as any,
            'find': [this.afterFind] as any,
            'join-players': [this.afterAddPlayer, this.sanitizeRoomPasscode] as any,
            'join-spectators': [this.afterAddPlayer, this.sanitizeRoomPasscode] as any,
            'leave': [this.afterRemovePlayer, this.sanitizeRoomPasscode] as any,
            'kick': [this.afterKickPlayer, this.sanitizeRoomPasscode] as any
          }
        },
        actions: {
          'health': this.health,
          'join-players': {
            cache: false,
            params: {
              roomId: 'string',
              clientId: 'string',
            },
            handler: ctx => this.addPlayer(ctx, 'players')
          },
          'join-spectators': {
            cache: false,
            params: {
              roomId: 'string',
              clientId: 'string',
            },
            handler: ctx => this.addPlayer(ctx, 'spectators')
          },
          'leave': {
            cache: false,
            params: {
              roomId: 'string',
              clientId: { optional: true, type: 'string' },
            },
            handler: this.removePlayer
          },
          'kick': {
            cache: false,
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
        started: this.startCleanupTimer,
        stopped: this.stopCleanupTimer,
      },
    );
  }

  /**
   * Daily sweep for rooms nothing will ever delete.
   *
   * Deleting a room is purely event-driven: the last player leaving triggers
   * it. Every missed event is therefore permanent, and they are missed
   * constantly (a tab closed without a clean socket close, a deploy killing
   * in-flight work, a mobile browser backgrounded). The result was 35,806
   * empty rooms, still growing by 330-460 a day, listed in the lobby where
   * new players walked into them.
   *
   * scripts/cleanup-stale-data.js has done this since 2026-07-15 but was
   * never scheduled. Running it in-process needs no new infrastructure and no
   * second copy of the Mongo credentials. Deletes are idempotent, so extra
   * replicas racing each other is harmless.
   */
  private cleanupTimer: any = null;

  private async sweepStaleRooms() {
    const STALE_DAYS = 7;
    try {
      const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
      // Rooms predating the createdAt field have no timestamp, so fall back to
      // the ObjectId's own embedded time.
      const cutoffId = ObjectId.createFromTime(Math.floor(cutoff / 1000));
      const res = await this.adapter.collection.deleteMany({
        players: { $size: 0 },
        $or: [{ createdAt: { $lt: cutoff } }, { createdAt: { $exists: false }, _id: { $lt: cutoffId } }],
      });
      if (res.deletedCount) {
        this.logger.info(`room sweep: removed ${res.deletedCount} empty rooms older than ${STALE_DAYS}d`);
      }
    } catch (e) {
      this.logger.error('room sweep failed', e);
    }
  }

  private async startCleanupTimer(): Promise<void> {
    const DAY = 24 * 60 * 60 * 1000;
    // Not on boot: a deploy restarts every service at once and this would run
    // against a cold database while rooms are still reconnecting.
    this.cleanupTimer = setInterval(() => this.sweepStaleRooms(), DAY);
    setTimeout(() => this.sweepStaleRooms(), 5 * 60 * 1000);
  }

  private async stopCleanupTimer(): Promise<void> {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  /**
   * Ensure the user the action is being performed on is the user making the action.
   *
   * @private
   * @param {Context<{ clientId }, any>} ctx
   * @return {*}  {Promise<Context<any, any>>}
   * @memberof RoomsService
   */
  private confirmUserAction(ctx: Context<{ clientId }, any>): Promise<Context<any, any>> {
    const userIdOfRequest = ctx.meta.user.uid;
    if (userIdOfRequest !== ctx.params.clientId) {
      return Promise.reject(new Errors.MoleculerError('You do not have privilages to perform this action', 401))
    }
    return Promise.resolve(ctx);
  }

  /**
   * Remove the passcode from the room returned to the user.
   *
   * @private
   * @param {Context} _
   * @param {{ passcode?: any }} res
   * @return {*}  {*}
   * @memberof RoomsService
   */
  private sanitizeRoomPasscode(_: Context, res: { passcode?: any }): any {
    if (res?.passcode) {
      res.passcode = true;
    }
    return res;
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
   * Keep player-less rooms out of the listing.
   *
   * A room is supposed to be destroyed when its last player leaves, but any
   * departure the service never observes (tab closed, process restart) leaks
   * the row. 35,797 of 38,367 rooms were empty when this was written, and the
   * lobby pages ten at a time straight off the collection, so the first page
   * came back almost entirely corpses: 7 of 10, with one joinable game on it.
   * The client filters what it receives, which cannot recover rooms that were
   * never in the page. Reported as "had trouble finding a game". Filtering at
   * query time also means a future leak can never crowd the lobby again.
   * An explicit players.0 query still wins, so admin can ask for the corpses.
   *
   * @private
   * @param {Context<any>} ctx
   * @returns {Context<any>}
   * @memberof RoomsService
   */
  private beforeList(ctx: Context<any>): Context<any> {
    const params: any = ctx.params || {};
    if (typeof params.query === 'string') {
      try { params.query = JSON.parse(params.query); } catch { params.query = {}; }
    }
    if (!params.query || typeof params.query !== 'object') { params.query = {}; }
    if (params.query['players.0'] === undefined) {
      params.query['players.0'] = { $exists: true };
    }
    // Newest first, or the lobby is useless. With no sort the collection came
    // back in natural order, so page 1 held rooms created 113 days ago and a
    // room made a minute ago landed on page 279 of 279. Nobody browsing ever
    // saw a fresh game, which is what "created a public room, it never
    // appeared in the room list" was. Sort on _id, not createdAt: createdAt is
    // optional on the schema so older rows do not carry it, and an ObjectId is
    // always present and already monotonic with creation time.
    if (params.sort === undefined) {
      params.sort = '-_id';
    }
    ctx.params = params;
    return ctx;
  }

  /**
   * Check to see if a host already owns some Rooms. Delete all existing rooms.
   *
   * @private
   * @param {Context<Room>} ctx
   * @returns {Promise<Context<Room, any>>}
   * @memberof RoomsService
   */
  private async beforeCreate(ctx: Context<Room, any>): Promise<Context<Room, any>> {
    const rooms = await ctx.call<Room[], any>(`${this.name}.find`, { query: { host: ctx.meta.user.uid } });

    // A player can only have one room. Remove all previously existing rooms for that host.
    await Promise.all(rooms.map(room => ctx.call(`${this.name}.remove`, { id: room._id }).catch(() => { })));

    const host = ctx.meta.user.uid;
    ctx.params.players = [host];
    ctx.params.host = host;
    (ctx.params as any).createdAt = Date.now();
    return ctx;
  }

  /**
   * Given the room id and client id. Remove the client from the room.
   *
   * @private
   * @param {Context} ctx
   * @param {string} roomId
   * @param {string} clientId
   * @returns
   * @memberof RoomsService
   */
  private removeClientFromRoom(ctx: Context, roomId: string, clientId: string) {
    return this.adapter.updateById(roomId, { $pull: { players: clientId, spectators: clientId } })
      .then(json => this.entityChanged('updated', json, ctx).then(() => json));
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

    return this.removeClientFromRoom(ctx, roomId, clientId);
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

    return this.removeClientFromRoom(ctx, roomId, clientId);
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
    return ctx.call(`clients.get`, { id: clientId })
      // If the client cannot be found, try renew their subscription. They may have disconnected.
      .catch(() => ctx.call('clients.renew'))
      .then(async (user: any) => {
        // check if the user is in a room.
        if (user?.roomId?.length) {
          if (user.roomId === roomId) {
            // user is already in this room.
            return Promise.resolve(room);
          } else {
            // user must be in another room. Leave the other room.
            try {
              await this.removeClientFromRoom(ctx, user.roomId, clientId);
            } catch (e) { }
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
      });

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
      { new: true }
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
   * Emit an event when a room is created.
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
   * Emit an event when a room is updated.
   *
   * @private
   * @param {*} json
   * @param {Context} ctx
   * @returns
   * @memberof RoomsService
   */
  private async entityUpdated(json: Room, ctx: Context) {
    // occassionally json is null.
    if (!json) {
      return null;
    }

    if (json.passcode) {
      (json as any).passcode = true;
    }

    // Everyone has left. Destroy the room.
    if (!json.players?.length) {
      try {
        await ctx.call(`${this.name}.remove`, { id: json._id });
        return;
      } catch (e) {
        this.logger.error(e);
      }
    }

    // The host left but players remain: promote the longest-standing survivor.
    // Starting, "play again" and kicking are all host-gated, so a room with no
    // host in it is a room nobody can ever start. This case used to be handled
    // only for PENDING rooms, and by destroying them, so a host who quit
    // mid-game (status 'started') left the room hostless: everyone still
    // sitting in it was stranded the moment that game finished, with no button
    // to press. 1,141 rooms were in that state when this was written, 61 of
    // them with players still waiting in one.
    if (json.players?.length && !json.players.includes(json.host)) {
      try {
        const promoted = await this.adapter.updateById(json._id, { $set: { host: json.players[0] } });
        // Re-enters this handler with a valid host, which emits 'updated' there.
        return this.entityChanged('updated', promoted, ctx);
      } catch (e) {
        this.logger.error(e);
      }
    }

    ctx.emit(`${this.name}.updated`, json);
  }

  /**
   * Emit an event when a room is removed.
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
