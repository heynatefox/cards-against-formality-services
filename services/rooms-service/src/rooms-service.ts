import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';

import dbMixin from '../mixins/db.mixin';

/**
 * Status is an enumerated value to indicate the status of the room.
 *
 * @enum {number}
 */
enum Status {
  PENDING = 'status',
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
    players: { type: 'array', items: 'string', default: [] },
    spectators: { type: 'array', items: 'string', default: [] },
    name: { type: 'string', pattern: '^[a-zA-Z0-9]+([_ -]?[a-zA-Z0-9])*$', min: 4, max: 12 },
    status: { type: 'enum', values: ['pending', 'started', 'finished'], default: 'pending' },
    options: {
      type: 'object', strict: true, props: {
        decks: { type: 'array', items: 'string', default: [] },
        target: { type: 'number', min: 5, max: 100, default: 10 },
        maxPlayers: { type: 'number', default: 10, min: 4, max: 10 }
      },
    },
    passcode: { type: 'string', pattern: '^[a-zA-Z0-9]+([_ -]?[a-zA-Z0-9])*$', min: 4, max: 12 },
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
          dbMixin('rooms')
        ],
        settings: {
          entityValidator: this.validationSchema
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
              clientId: 'string',
            },
            handler: this.removePlayer
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
   * Given an _id for the room and client, remove the client from spectators and players.
   *
   * @private
   * @param {Context<{ roomId: string; clientId: string }>} ctx
   * @returns {Promise<Room>}
   * @memberof RoomsService
   */
  private removePlayer(ctx: Context<{ roomId: string; clientId: string }>): Promise<Room> {
    const { roomId, clientId } = ctx.params;
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
  private async addPlayer(ctx: Context<{ roomId: string; clientId: string }>, arrayProp: string): Promise<Room> {
    const { roomId, clientId } = ctx.params;

    // Check if the user is currently in a game.
    const count = await ctx.call(
      `${this.name}.count`,
      { query: { $or: [{ players: clientId }, { spectators: clientId }] } }
    );

    if (count > 0) {
      throw new Error('User is already in a room');
    }

    const room: Room = await ctx.call(`${this.name}.get`, { id: roomId });
    // Check whether this client would surpass the max number of players.
    if (room.players.length + 1 > room.options.maxPlayers) {
      throw new Error('Room is full');
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
      .then(doc => {
        // Client is not in any rooms
        if (!doc?.values) {
          return null;
        }
        this.entityChanged('updated', doc.value, ctx).then(() => doc.value);
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
   * @memberof RoomsService
   */
  private entityRemoved(json: any, ctx: Context) {
    return ctx.emit(`${this.name}.removed`, json);
  }
}
