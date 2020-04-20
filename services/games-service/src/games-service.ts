import { Service, ServiceBroker, Context, NodeHealthStatus } from 'moleculer';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';
import dbMixin from '@cards-against-formality/db-mixin';

import Game, { Room } from './game';

export default class DecksService extends Service {

  private games: Game[] = [];

  constructor(_broker: ServiceBroker) {
    super(_broker);

    this.parseServiceSchema(
      {
        name: 'games',
        mixins: [
          dbMixin('games'),
          CacheCleaner([
            'cache.clean.cards',
            'cache.clean.decks',
            'cache.clean.rooms',
          ])
        ],
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

    return ctx.call<Room, any>('rooms.update', { id: roomId, status: 'started' })
      .then(room => {
        this.games.push(new Game(room, this.broker, this.logger));
        return { message: 'Game successfully started' };
      })
      .catch(err => {
        this.logger.error(err);
        throw new Error('Failed to start game');
      });
  }

  private submitCards(ctx: Context<{ clientId: string; roomId: string; cards: string[] }>) {
    const { roomId, cards, clientId } = ctx.params;
    const foundGame = this.games.find(game => game.room._id === roomId);
    foundGame.onHandSubmitted(clientId, cards);
    return { message: 'Cards successfully submitted' };
  }

  private selectWinner(ctx: Context<{ clientId: string; roomId: string; winnerId: string }>) {
    const { clientId, roomId, winnerId } = ctx.params;
    const foundGame = this.games.find(game => game.room._id === roomId);
    foundGame.onWinnerSelected(winnerId, clientId);
    return { message: 'Winner selected' };
  }

  private handlePlayerJoined(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    const foundGame = this.games.find(game => game.room._id === roomId);
    if (foundGame) {
      foundGame.onPlayerJoin(clientId);
    }
  }

  private handlePlayerLeft(ctx: Context<{ clientId: string; roomId: string }>) {
    const { clientId, roomId } = ctx.params;
    const foundGame = this.games.find(game => game.room._id === roomId);
    if (foundGame) {
      foundGame.onPlayerLeave(clientId);
    }
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

}
