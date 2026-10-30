import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app/create-app.js';
import { parseEnv } from '../src/config/env.js';
import { createLogger } from '../src/plugins/logging.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup() {
  const app = createApp(parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  apps.push(app);
  return app;
}

describe('API transport boundary', () => {
  it('serves the typed health contract with security headers and a generated request ID', async () => {
    const response = await setup().inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'untrusted-id' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'leadops-api' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-request-id']).not.toBe('untrusted-id');
  });
  it('rejects unexpected health query parameters', async () => {
    const response = await setup().inject('/health?organizationId=untrusted');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(response.body).not.toContain('untrusted');
  });
  it('returns a consistent safe 404, including deferred product routes', async () => {
    const app = setup();
    for (const url of ['/unknown', '/leads', '/agents/run', '/ready']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Route not found.',
          requestId: response.headers['x-request-id'],
        },
      });
    }
  });
  it('sanitizes unexpected failures in production', async () => {
    const app = createApp({
      ...parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      nodeEnv: 'production',
      corsOrigins: ['https://app.example'],
    });
    apps.push(app);
    app.get('/test-failure', () => {
      throw new Error('private database details');
    });
    const response = await app.inject('/test-failure');
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toMatch(/private|stack|database/);
  });
  it('enforces the 16 KiB body limit', async () => {
    const app = setup();
    app.post('/test-body', () => ({ accepted: true }));
    const response = await app.inject({
      method: 'POST',
      url: '/test-body',
      payload: { value: 'x'.repeat(17 * 1024) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });
  it('sanitizes malformed JSON', async () => {
    const app = setup();
    app.post('/test-body', () => ({ accepted: true }));
    const response = await app.inject({
      method: 'POST',
      url: '/test-body',
      headers: { 'content-type': 'application/json' },
      payload: '{private',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('private');
  });
  it('allows exact configured origins and omits CORS permission for others', async () => {
    const app = setup();
    const allowed = await app.inject({
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
    for (const origin of [
      'https://attacker.example',
      'http://localhost:5173.attacker.example',
      'null',
    ]) {
      const blocked = await app.inject({ url: '/health', headers: { origin } });
      expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
  it('supports valid preflight without wildcard origins', async () => {
    const response = await setup().inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
  it('does not log authorization, cookies, query values, bodies, or raw exception messages', async () => {
    const logs: string[] = [];
    const config = parseEnv({ NODE_ENV: 'test' });
    const logger = createLogger(config, {
      write: (chunk) => {
        logs.push(chunk);
      },
    });
    const app = createApp(config, logger);
    apps.push(app);
    app.get('/test-failure', () => {
      throw new Error('exception-sensitive-value');
    });
    await app.inject({
      url: '/test-failure?token=query-sensitive-value',
      headers: { authorization: 'header-sensitive-value', cookie: 'cookie-sensitive-value' },
    });
    logger.info(
      {
        token: 'token-sensitive-value',
        password: 'password-sensitive-value',
        body: { value: 'body-sensitive-value' },
      },
      'redaction test',
    );
    const output = logs.join('');
    expect(output).toContain('Request failed');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('sensitive-value');
  });
});
