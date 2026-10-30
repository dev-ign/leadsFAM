import pino, { type DestinationStream } from 'pino';
import type { AppConfig } from '../config/env.js';

export function createLogger(config: AppConfig, destination?: DestinationStream) {
  return pino(
    {
      level: config.logLevel,
      base: { service: 'leadops-api', environment: config.nodeEnv },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
          'password',
          'token',
          'secret',
          'apiKey',
          'body',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req: (request: { method: string; url: string }) => ({
          method: request.method,
          path: request.url.split('?')[0],
        }),
        res: (response: { statusCode: number }) => ({ statusCode: response.statusCode }),
        err: (error: Error & { code?: string }) => ({ type: error.name, code: error.code }),
      },
    },
    destination,
  );
}
