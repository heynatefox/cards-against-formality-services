import { ServiceBroker } from 'moleculer';
import HealthMiddleware from '@cards-against-formality/health-check-mixin';

import Service from './games-service';

process.on('unhandledRejection', (reason: any) => {
  if (reason?.name === 'EntityNotFoundError') {
    console.warn('Caught unhandled EntityNotFoundError — ignoring:', reason.data);
    return;
  }
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (err: any) => {
  if (err?.name === 'EntityNotFoundError') {
    console.warn('Caught uncaught EntityNotFoundError — ignoring:', err);
    return;
  }
  console.error('Uncaught exception:', err);
  process.exit(1);
});

const registry = {
  strategy: 'CpuUsage'
};

const circuitBreaker = {
  enabled: true,
  halfOpenTime: 10 * 1000,
};

const retryPolicy = {
  enabled: true,
  retries: 5,
  delay: 100,
  maxDelay: 2000,
  factor: 2,
  check: err => err && !!(err as any).retryable
};

const broker = new ServiceBroker({
  logger: true,
  middlewares: [HealthMiddleware()],
  logLevel: 'info',
  metrics: false,
  cacher: {
    type: 'Redis',
    options: {
      prefix: 'GAMES-MOL',
      redis: {
        ttl: 3600,
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT,
        password: process.env.REDIS_PASSWORD,
      }
    }
  },
  transporter: process.env.TRANSPORTER_URI,
  circuitBreaker,
  retryPolicy,
  registry
});

new Service(broker);

broker.start();
