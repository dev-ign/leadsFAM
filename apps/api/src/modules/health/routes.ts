import type { FastifyInstance } from 'fastify';
import { healthQuerySchema, healthResponseSchema, type HealthResponse } from '@leadops/shared';
import { z } from 'zod';

export function registerHealthRoutes(app: FastifyInstance) {
  app.get(
    '/health',
    {
      schema: {
        querystring: z.toJSONSchema(healthQuerySchema, { target: 'draft-7' }),
        response: { 200: z.toJSONSchema(healthResponseSchema, { target: 'draft-7' }) },
      },
    },
    (): HealthResponse => ({ status: 'ok', service: 'leadops-api' }),
  );
}
