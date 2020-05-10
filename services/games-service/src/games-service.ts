import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';
import dbMixin from '@cards-against-formality/db-mixin';

import Game, { Room, GameInterface } from './game';

export default class GameService extends Service {

  private gameService: Game = null;

  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'games',
        mixins: [
          dbMixin('games'),
          CacheCleaner([
            'cache.clean.games',
            'cache.clean.cards',
            'cache.clean.decks',
            'cache.clean.rooms',
          ])
        ],
        settings: {
          populates: {
            room: {
              action: 'rooms.get',
            }
          }
        },
        actions: {
          health: this.health,
          start: {
            params: {
              roomId: 'string'
            },
            handler: this.startGame
          },
          submit: {
            params: {
              clientId: 'string',
              roomId: 'string',
              cards: { type: 'array', items: 'string' }
            },
            handler: this.submitCards
          },
          winner: {
            params: {
              clientId: 'string',
              roomId: 'string',
              winnerId: 'string'
            },
            handler: this.selectWinner
          }
        },
        events: {
          'rooms.player.joined': this.handlePlayerJoined,
          'rooms.player.left': this.handlePlayerLeft,
          'rooms.removed': this.handleRoomRemoved,
          'games.turn.updated': ctx => this.gameService.onTurnUpdated(ctx.params)
        },
        entityCreated: this.entityCreated,
        entityUpdated: this.entityUpdated,
        entityRemoved: this.entityRemoved,
        started: () => {
          this.gameService = new Game(this.broker, this.logger);
          return null;
        }
      },
    );
  }

  private async startGame(ctx: Context<{ roomId: string }, { user: { uid: string } }>) {
    const { roomId } = ctx.params;
    const clientId = ctx.meta.user.uid;
    // TOOD: add check to ensure only host can start the game.
    // Check if the required number of players are in the game before starting.
    const _room: Room = await ctx.call('rooms.get', { id: roomId });
    if (_room.players.length < 2) {
      throw new Error('Not enough Players');
    }

    if (_room.host !== clientId) {
      throw new Error('Only the host can start the game');
    }

    return this.gameService.onGameStart(_room)
      .then(() => ({ message: 'Game successfully started' }))
      .catch(err => {
        this.logger.error(err);
        throw new Error('Failed to start game');
      });
  }

  private getGameMatchingRoom(ctx: Context, roomId: string): Promise<GameInterface> {
    return ctx.call(`${this.name}.find`, { query: { room: roomId }, populate: ['room'] })
      .then((games: GameInterface[]) => {
        if (!games?.length) {
          throw new Error('Unable to find game');
        }
        this.logger.info(games[0].room);
        return games[0];
      })
      .catch(err => {
        throw err;
      });
  }

  private async submitCards(ctx: Context<{ clientId: string; roomId: string; cards: string[] }>) {
    const { roomId, cards, clientId } = ctx.params;

    const game: any = await this.getGameMatchingRoom(ctx, roomId);
    await this.gameService.onHandSubmitted(game, clientId, cards);
    return { message: 'Cards successfully submitted' };
  }

  private async selectWinner(ctx: Context<{ clientId: string; roomId: string; winnerId: string }>) {
    const { clientId, roomId, winnerId } = ctx.params;
    const game: any = await this.getGameMatchingRoom(ctx, roomId);
    await this.gameService.onWinnerSelected(game, winnerId, clientId);
    return { message: 'Winner selected' };
  }

  private async handlePlayerJoined(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    return this.getGameMatchingRoom(ctx, roomId)
      .then((game) => {
        return this.gameService.onPlayerJoin(game, clientId);
      })
      .catch(err => {
        // game must not have started yet.
      });
  }

  private handlePlayerLeft(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    return this.getGameMatchingRoom(ctx, roomId)
      .then((game) => {
        return this.gameService.onPlayerLeave(
          game,
          clientId,
          this.adapter,
          json => this.entityChanged('updated', json, ctx).then(() => json)
        );
      })
      .catch(err => {
        // game must not have started yet.
      });
  }

  private async handleRoomRemoved(ctx: Context<{ _id: string }>) {
    return this.getGameMatchingRoom(ctx, ctx.params._id)
      .then((game) => this.gameService.destroyGame(game._id))
      .catch(() => {
        // game must not have started yet.
      });
  }

  /**
   * Get the health data for this service.
   *
   * @private
   * @param {Context} ctx
   * @returns {Promise<NodeHealthStatus>}
   * @memberof DecksService
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
