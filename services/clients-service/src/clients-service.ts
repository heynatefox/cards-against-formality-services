import { Service, ServiceBroker, Context, NodeHealthStatus, Errors } from 'moleculer';
import admin from 'firebase-admin';
import dbMixin from '@cards-against-formality/db-mixin';
import CacheCleaner from '@cards-against-formality/cache-clean-mixin';
import { createCheckout, verifySignature, recordDonation, board, sessionStatus, claimName, recordClick, nameIsBlocked, MIN_INCHES } from './donations';

/**
 * One username rule, used by the entity validator, the guest auto-register
 * path and the client's own pre-check. Any script's letters, any digits, and
 * single _ - or space between them. Kept as a named export so the rule cannot
 * fork again.
 */
export const USERNAME_PATTERN = /^[\p{L}\p{N}]+([_ -]?[\p{L}\p{N}])*$/u;
export const USERNAME_MIN = 2;
export const USERNAME_MAX = 16;
export function isValidUsername(name: string): boolean {
  const n = (name || '').trim();
  return n.length >= USERNAME_MIN && n.length <= USERNAME_MAX && USERNAME_PATTERN.test(n);
}


/**
 * Interface that represents the Client object.
 *
 * @interface Client
 */
interface Client {
  _id: string;
  username: string;
  email?: string;
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
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
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
    // Unicode-aware: the ASCII-only rule silently rejected every accented or
    // non-Latin name (José, Müller, Łukasz, and every Russian and Japanese
    // player) in a game localised into eleven languages. Bounds match the
    // client input (2-16) so the two can never disagree again.
    username: { type: 'string', pattern: '^[\\p{L}\\p{N}]+([_ -]?[\\p{L}\\p{N}])*$', patternFlags: 'u', min: 2, max: 16 },
    email: { type: 'string', optional: true },
    socket: { type: 'string', optional: true },
    roomId: { type: 'string', optional: true },
    disconnectedAt: { type: 'number', optional: true, default: null },
    // Newsletter consent captured by the V2 unlock flow (sent on login/renew).
    // marketingEmail holds typed emails from guests who never OAuth'd.
    marketingOptIn: { type: 'boolean', optional: true },
    marketingOptInAt: { type: 'number', optional: true },
    marketingEmail: { type: 'string', optional: true }
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
          // ── Measuring Dicks ────────────────────────────────────────────
          // Opens a Stripe Checkout Session. Public: anyone can donate, and
          // requiring an account would kill the impulse this whole thing runs
          // on.
          'donate-checkout': {
            params: {
              inches: { type: 'number', convert: true, min: MIN_INCHES },
              name: { type: 'string', optional: true, max: 40 },
              ref: { type: 'string', optional: true, max: 40 },
              donor: { type: 'string', optional: true, max: 64 },
              origin: { type: 'string', optional: true, max: 120 },
              from: { type: 'string', optional: true, max: 24 },
              // Which framing of the page they were shown. Rides the same
              // route as `from` so a completed donation says which pitch
              // earned it, which is unknowable after the fact.
              copy: { type: 'string', optional: true, max: 16 },
            },
            handler: this.donateCheckout
          },
          // Stripe calls this. Signature-verified against the raw body; the
          // event id is the primary key so replays cannot double-credit.
          'stripe-webhook': {
            handler: this.stripeWebhook
          },
          // The public board. Cached briefly: it is read on every page view
          // and changes only when money arrives.
          // Asked by the success page after Stripe redirects back.
          'donate-session': {
            params: { id: { type: 'string', max: 200 } },
            handler: this.donateSession
          },
          // Lets a donor put a name on a row they already paid for.
          'donate-name': {
            params: {
              id: { type: 'string', max: 200 },
              name: { type: 'string', min: 1, max: 40 },
            },
            handler: this.donateName
          },
          // One millimetre of girth per unique visitor who follows a link.
          'donate-click': {
            params: {
              ref: { type: 'string', max: 64 },
              visitor: { type: 'string', max: 64 },
            },
            handler: this.donateClick
          },
          'donations-board': {
            cache: { ttl: 20, keys: ['span'] },
            params: { span: { type: 'enum', values: ['all', 'month'], optional: true } },
            handler: this.donationsBoard
          },

          // Authoritative mailing-list size, read from Beehiiv. The local

          // marketingOptIn count only covers V2-era opt-ins; the real list

          // predates it. Returns null when unconfigured or on any failure so

          // the dashboard degrades to the local number instead of lying.

          'newsletter-stats': {

            cache: { ttl: 300 },

            handler: this.newsletterStats

          },
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
          'client.login': this.onClientLoggedIn
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
  private checkUsername(ctx: Context<{ username: string }>) {
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
    if (ctx.params.isAnonymous && !ctx.params.username?.length) {
      // support legacy anon username.
      ctx.params.username = `Anon-${Math.round(Math.random() * 9999)}`;
    }

    const { username, displayName, photoURL, email, emailVerified, phoneNumber, isAnonymous } = ctx.params;
    const { uid } = ctx.meta.user;
    const data = { username, uid, displayName, photoURL, email, emailVerified, phoneNumber, isAnonymous };

    return this.checkUsername(ctx)
      .then(() => {
        // username doesn't already exist. continue with signup.
        return this.firestoreDb
          .collection('users')
          .doc(data.uid)
          .set(this.sanitizeFirestoreInput(Object.assign({}, data, { lastLoggedIn: +new Date() })));
      })
      .then(async () => {
        return this.firestoreDb
          .collection('usernames')
          .doc(username)
          .set({ uid: data.uid });
      })
      .then(() => ctx.call(
        `${this.name}.create`, { 
          _id: data.uid, 
          isAnonymous: data.isAnonymous, 
          username: data.username, 
          ...( data.email ? { email: data.email } : {})
        }
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
  private async renew(ctx: Context<any, { user: { uid: string; firebase?: { sign_in_provider: string } } }>): Promise<Client> {
    const uid = ctx.meta.user.uid;

    // V2 sends marketingOptIn on renew when the user joins the email list
    // (the expansion-pack unlock). Guests may include a typed marketingEmail;
    // signed-in users' account email comes from the token. Push to Beehiiv
    // immediately (fire-and-forget, never blocks login); persist the flag
    // AFTER the renew resolves, because on a guest's first renew the client
    // record does not exist yet. This used to run before creation, fail, and
    // get swallowed as "harmless" — so the email reached Beehiiv but the local
    // flag was never set and the opt-in was invisible to our own dashboard.
    const optIn = ctx.params?.marketingOptIn === true;
    const typedEmail: string | undefined =
      optIn && typeof ctx.params.marketingEmail === 'string' && ctx.params.marketingEmail.includes('@')
        ? ctx.params.marketingEmail.trim()
        : undefined;
    if (optIn) {
      this.pushToBeehiiv(typedEmail || (ctx.meta.user as any)?.email);
    }

    const persistOptIn = (client: Client): Client => {
      if (!optIn) {
        return client;
      }
      // Retry once on the next tick: create() may still be settling.
      const apply = () => ctx.call(`${this.name}.update`, {
        id: uid,
        marketingOptIn: true,
        marketingOptInAt: Date.now(),
        ...(typedEmail ? { marketingEmail: typedEmail } : {})
      });
      apply().catch(() => setTimeout(() => { apply().catch(() => undefined); }, 750));
      return client;
    };

    return this.firestoreDb
      .collection('users')
      .doc(uid)
      .get()
      .then(async doc => {
        if (doc.exists) {
          await ctx.emit('client.login', { uid });
          // try get the user from our cluster collection, if it doesn't exist create it.
          return ctx.call<any, any>(`${this.name}.get`, { id: uid })
            .then(persistOptIn)
            .catch(() => {
              const data = doc.data();
              return ctx.call(
                `${this.name}.create`, {
                  _id: data.uid,
                  isAnonymous: data.isAnonymous,
                  username: data.username,
                  ...( data.email ? { email: data.email } : {})
                }
              ).then(persistOptIn as any);
            });
        }

        // Anonymous Firebase users have no Firestore record until their first renew.
        // Auto-register them so they can play without going through the login flow.
        // Guests pick a nickname at sign-in; the client sends it along on this
        // first renew. Honor it when it passes the username rules, otherwise
        // fall back to the Anon handle. Duplicate guest nicknames are fine
        // (display names, not identities).
        if (ctx.meta.user.firebase?.sign_in_provider === 'anonymous') {
          let username = `Anon-${uid.slice(-4)}`;
          const requested = typeof ctx.params?.username === 'string' ? ctx.params.username.trim() : '';
          // Must stay in step with the entity validator above and with the
          // client's own check. When these drifted apart, a guest typed a
          // name, the modal accepted it, and the server quietly handed back
          // Anon-xxxx: "I uploaded my name and it gave me an anonymous name".
          if (isValidUsername(requested)) {
            username = requested;
          } else if (requested.length) {
            this.logger.info(`guest nickname rejected, falling back to ${username}: ${JSON.stringify(requested).slice(0, 40)}`);
          }
          const data = { uid, username, isAnonymous: true, displayName: null, photoURL: null, email: null, emailVerified: false, phoneNumber: null };
          await this.firestoreDb
            .collection('users')
            .doc(uid)
            .set(this.sanitizeFirestoreInput(Object.assign({}, data, { lastLoggedIn: +new Date() })));
          return ctx.call<Client, any>(`${this.name}.create`, { _id: uid, isAnonymous: true, username })
            .then(persistOptIn);
        }

        // Non-anonymous user with no Firestore record — they need to register first.
        throw new Errors.MoleculerError('User doesnt exist', 404, 'USERNAME_NON_EXISTENT');
      });
  }

  /**
   * Live subscriber counts from Beehiiv.
   * GET /v2/publications/{id}?expand=stats -> { data: { stats: {...} } }
   *
   * @private
   * @returns {Promise<{ active: number; free: number; premium: number } | null>}
   * @memberof ClientsService
   */
  private async newsletterStats(): Promise<{ active: number; free: number; premium: number } | null> {
    const key = process.env.BEEHIIV_API_KEY;
    const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
    if (!key || !publicationId) {
      return null;
    }
    const fetchFn = (globalThis as any).fetch;
    if (typeof fetchFn !== 'function') {
      return null;
    }
    try {
      const res = await fetchFn(
        `https://api.beehiiv.com/v2/publications/${publicationId}?expand=stats`,
        { headers: { Authorization: `Bearer ${key}` } }
      );
      if (!res.ok) {
        this.logger.warn(`Beehiiv stats failed: ${res.status}`);
        return null;
      }
      const body: any = await res.json();
      const stats = body?.data?.stats;
      if (!stats || typeof stats.active_subscriptions !== 'number') {
        this.logger.warn('Beehiiv stats: unexpected response shape');
        return null;
      }
      return {
        active: stats.active_subscriptions,
        free: stats.active_free_subscriptions ?? 0,
        premium: stats.active_premium_subscriptions ?? 0,
      };
    } catch (err) {
      this.logger.warn(`Beehiiv stats failed: ${err?.message}`);
      return null;
    }
  }

  /**
   * Subscribe an email to the Beehiiv publication. No-op until
   * BEEHIIV_API_KEY + BEEHIIV_PUBLICATION_ID are set (Railway env vars).
   * API: POST /v2/publications/{id}/subscriptions, Bearer auth.
   *
   * @private
   * @param {string} [email]
   * @memberof ClientsService
   */
  private pushToBeehiiv(email?: string, medium: string = 'deck_unlock') {
    const key = process.env.BEEHIIV_API_KEY;
    const publicationId = process.env.BEEHIIV_PUBLICATION_ID;
    if (!key || !publicationId || !email) {
      return;
    }
    // @types/node here predates the fetch global; grab it off globalThis.
    const fetchFn = (globalThis as any).fetch;
    if (typeof fetchFn !== 'function') {
      this.logger.warn('Beehiiv push skipped: runtime has no fetch (Node < 18)');
      return;
    }
    fetchFn(`https://api.beehiiv.com/v2/publications/${publicationId}/subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      // Same params as V1's NewsletterGate (welcome email flow is configured
      // in Beehiiv), plus utm attribution.
      body: JSON.stringify({
        email,
        reactivate_existing: false,
        send_welcome_email: true,
        utm_source: 'cards-against-formality',
        utm_medium: medium,
      }),
    })
      .then((res: any) => {
        if (!res.ok) {
          this.logger.warn(`Beehiiv push failed: ${res.status}`);
        }
      })
      .catch((err: any) => this.logger.warn(`Beehiiv push failed: ${err?.message}`));
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
    const count: number = await ctx.call(`${this.name}.count`, { query: { _id: clientId, roomId } });
    if (count <= 0) {
      this.logger.warn('Client tried to leave a room its no longer in', { clientId, roomId });
      return;
    }

    return ctx.call(`${this.name}.update`, { id: clientId, roomId: null })
      .catch(() => { });
  }

  /**
   * On Client logged in. Store the last logged in time. Mainly to clean up anonymous users.
   *
   * @private
   * @param {Context<{ uid: string }>} ctx
   * @returns
   * @memberof ClientsService
   */
  private onClientLoggedIn(ctx: Context<{ uid: string }>) {
    return this.firestoreDb
      .collection('users')
      .doc(ctx.params.uid)
      .update({ lastLoggedIn: +new Date() });
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

  /** Hands back a Stripe Checkout URL for the frontend to redirect to. */
  private async donateCheckout(
    ctx: Context<{ inches: number; name?: string; ref?: string; origin?: string; donor?: string; from?: string; copy?: string }>,
  ) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Errors.MoleculerError('Donations unavailable', 503, 'NO_STRIPE');

    // Checked here as well as on rename: the pre-payment field reaches the
    // board just the same, and stopping it before Stripe means no refund to
    // unwind afterwards.
    if (ctx.params.name && nameIsBlocked(ctx.params.name)) {
      throw new Errors.MoleculerError('Pick a different name', 400, 'NAME_BLOCKED');
    }

    // Return the donor to the site they actually came from. Validated against
    // an allowlist inside createCheckout, so this cannot become an open redirect.
    try {
      const { url, id } = await createCheckout(key, {
        inches: ctx.params.inches,
        name: ctx.params.name,
        ref: ctx.params.ref,
        // Without this the id is accepted and silently dropped, and repeat
        // donations never stack.
        donor: ctx.params.donor,
        from: ctx.params.from,
        copy: ctx.params.copy,
        origin: ctx.params.origin || '',
      });
      return { url, id };
    } catch (e) {
      const msg = (e as any)?.message;
      this.logger.error('checkout failed', msg);
      throw new Errors.MoleculerError(msg || 'Checkout failed', 400, 'CHECKOUT_FAILED');
    }
  }

  /**
   * Stripe webhook. Returns 200 on anything it has already handled or does not
   * care about: a non-2xx makes Stripe retry, and retrying an event we have
   * deliberately ignored just generates noise forever.
   */
  private async stripeWebhook(ctx: Context<any, any>) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Errors.MoleculerError('Not configured', 503, 'NO_WEBHOOK_SECRET');

    const raw = ctx.meta?.rawBody;
    const sig = ctx.meta?.stripeSignature;
    if (!verifySignature(raw, sig, secret)) {
      this.logger.warn('stripe webhook: bad signature');
      throw new Errors.MoleculerError('Invalid signature', 400, 'BAD_SIGNATURE');
    }

    const event = JSON.parse(raw);
    if (event.type !== 'checkout.session.completed') return { ignored: event.type };
    if (event?.data?.object?.payment_status !== 'paid') return { ignored: 'unpaid' };

    const db = (this.adapter as any)?.db;
    if (!db) throw new Errors.MoleculerError('Storage unavailable', 500, 'NO_DB');

    const { result, optInEmail } = await recordDonation(db, event);
    this.logger.info(`donation ${result}: ${event.id}`);
    // Only ever set on a first insert with an explicit opt-in, so a Stripe
    // retry cannot resubscribe someone and a receipt address never leaks here.
    if (optInEmail) this.pushToBeehiiv(optInEmail, 'donation');
    await this.broker.cacher?.clean('clients.donations-board:**');
    return { ok: true, result };
  }

  /** Status of one checkout session, for the page Stripe redirects back to. */
  private async donateSession(ctx: Context<{ id: string }>) {
    const db = (this.adapter as any)?.db;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!db || !key) return { paid: false, recorded: false };
    try {
      return await sessionStatus(db, key, ctx.params.id);
    } catch (e) {
      this.logger.error('session lookup failed', (e as any)?.message);
      return { paid: false, recorded: false };
    }
  }

  /** Names a donation after the fact, authorised by its checkout session id. */
  private async donateName(ctx: Context<{ id: string; name: string }>) {
    const db = (this.adapter as any)?.db;
    if (!db) throw new Errors.MoleculerError('Storage unavailable', 500, 'NO_DB');
    try {
      if (nameIsBlocked(ctx.params.name)) {
        throw new Errors.MoleculerError('Pick a different name', 400, 'NAME_BLOCKED');
      }
      const out = await claimName(db, ctx.params.id, ctx.params.name);
      await this.broker.cacher?.clean('clients.donations-board:**');
      return out;
    } catch (e) {
      throw new Errors.MoleculerError((e as any)?.message || 'Could not set name', 400, 'CLAIM_FAILED');
    }
  }

  /** Credits girth for a referred visit. */
  private async donateClick(ctx: Context<{ ref: string; visitor: string }>) {
    const db = (this.adapter as any)?.db;
    if (!db) return { ok: false };
    try {
      return { ok: true, result: await recordClick(db, ctx.params.ref, ctx.params.visitor) };
    } catch {
      return { ok: false };
    }
  }

  /** Public leaderboard plus the running total the meter is driven by. */
  private async donationsBoard(ctx: Context<{ span?: 'all' | 'month' }>) {
    const db = (this.adapter as any)?.db;
    if (!db) return { rows: [], totalInches: 0 };
    return board(db, ctx.params.span || 'all', 100);
  }

}
