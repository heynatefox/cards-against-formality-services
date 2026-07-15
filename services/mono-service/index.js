/**
 * Mono-process runner — loads every internal service plus the web gateway
 * onto ONE Moleculer broker in ONE container.
 *
 * Why: the current deployment runs 8 containers 24/7 for a low-traffic game.
 * Moleculer doesn't care about process boundaries — with all services on one
 * broker, calls are in-memory (faster than the network transporter) and the
 * TRANSPORTER + Redis cacher become optional.
 *
 * What runs here: clients, cards, decks, rooms, games, web-gateway.
 * What does NOT: websocket-gateway-service — Railway exposes one public port
 * per service, and the socket lives on its own domain. Run it as a second
 * Railway service and keep TRANSPORTER_URI set on BOTH so the two processes
 * can reach each other. (8 containers -> 2.)
 *
 * Build first: `npx lerna run build` from the repo root (compiles each
 * package's TypeScript to build/).
 *
 * Env: same as today (MONGO_URI, firebase creds, PORT for the gateway).
 * REDIS_* optional — falls back to in-memory cache when unset.
 * TRANSPORTER_URI required only while the ws-gateway runs separately.
 */
const { ServiceBroker } = require('moleculer');
const HealthMiddleware = require('@cards-against-formality/health-check-mixin');

process.on('unhandledRejection', (reason) => {
  if (reason && reason.name === 'EntityNotFoundError') return;
  console.error('Unhandled rejection:', reason);
});

const cacher = process.env.REDIS_HOST
  ? {
      type: 'Redis',
      options: {
        prefix: 'MONO-MOL',
        redis: {
          ttl: 3600,
          host: process.env.REDIS_HOST,
          port: process.env.REDIS_PORT,
          password: process.env.REDIS_PASSWORD,
        },
      },
    }
  : { type: 'Memory', options: { ttl: 3600 } };

const broker = new ServiceBroker({
  logger: true,
  logLevel: 'info',
  middlewares: [HealthMiddleware.default ? HealthMiddleware.default() : HealthMiddleware()],
  metrics: false,
  cacher,
  // In-memory when unset — fine for single-process. Set TRANSPORTER_URI while
  // the websocket gateway runs as a separate Railway service.
  transporter: process.env.TRANSPORTER_URI || undefined,
  circuitBreaker: { enabled: true, halfOpenTime: 10 * 1000 },
  retryPolicy: {
    enabled: true,
    retries: 5,
    delay: 100,
    maxDelay: 2000,
    factor: 2,
    check: (err) => err && !!err.retryable,
  },
});

const SERVICES = [
  '../clients-service/build/clients-service',
  '../cards-service/build/cards-service',
  '../decks-service/build/decks-service',
  '../rooms-service/build/rooms-service',
  '../games-service/build/games-service',
  '../web-gateway-service/build/web-gateway-service',
];

for (const path of SERVICES) {
  const mod = require(path);
  const ServiceClass = mod.default || mod;
  new ServiceClass(broker);
  console.log(`[mono] loaded ${path}`);
}

broker.start().then(() => console.log('[mono] all services up on one broker'));
