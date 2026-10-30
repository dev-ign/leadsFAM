import { randomUUID } from 'node:crypto';
import Fastify, { type RawServerDefault, type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
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
    origin: (origin, callback) =>
      callback(null, origin !== undefined && config.corsOrigins.includes(origin)),
    credentials: false,
    methods: ['GET', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    strictPreflight: true,
  });
  registerHealthRoutes(app);
  return app;
}
