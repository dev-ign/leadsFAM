import { randomUUID } from 'node:crypto';
import Fastify, { type RawServerDefault, type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { SessionStore } from '../modules/identity/sessions.js';
import { registerIdentity } from '../modules/identity/routes.js';
import { registerOrganizations } from '../modules/organizations/routes.js';
import { IdentityFailure } from '../modules/identity/failure.js';
import type { AppConfig } from '../config/env.js';
import { createLogger } from '../plugins/logging.js';
import { registerErrorHandlers } from '../plugins/errors.js';
import { registerHealthRoutes } from '../modules/health/routes.js';

export function createApp(config: AppConfig, logger?: FastifyBaseLogger) {
  const app = Fastify<RawServerDefault>({
    loggerInstance: logger ?? createLogger(config),
    bodyLimit: 16 * 1024,
    requestTimeout: 10_000,
    connectionTimeout: 10_000,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  registerErrorHandlers(app);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
  });
  void app.register(helmet);
  void app.register(cors, {
    delegator: (request, callback) =>
      callback(null, {
        origin: (origin, done) =>
          done(null, origin !== undefined && config.corsOrigins.includes(origin)),
        credentials: request.url.startsWith('/v1/'),
        methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PATCH', 'DELETE'],
        allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
        strictPreflight: true,
      }),
  });
  void app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  void app.register(
    async (scoped) => {
      if (!config.identity) {
        scoped.all('/*', async () => {
          throw new IdentityFailure(503, 'IDENTITY_UNAVAILABLE');
        });
        return;
      }
      const store = new SessionStore(config.identity);
      scoped.addHook('onClose', async () => {
        await store.stop();
      });
      await store.start(() =>
        scoped.log.error(
          { event: 'session_cleanup_failed' },
          'Session cleanup failed; expiry remains enforced',
        ),
      );
      registerIdentity(scoped, store, config.nodeEnv === 'production', config.corsOrigins);
      registerOrganizations(scoped, store);
    },
    { prefix: '/v1' },
  );
  registerHealthRoutes(app);
  return app;
}
