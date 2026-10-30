import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

describe('server configuration', () => {
  it('uses safe local defaults without cloud secrets', () => {
    expect(parseEnv({})).toMatchObject({
      host: '127.0.0.1',
      port: 3001,
      corsOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    });
  });
  it.each(['0', '-1', '65536', 'three'])('rejects invalid port %s', (port) => {
    expect(() => parseEnv({ PORT: port })).toThrow('PORT');
  });
  it.each([
    '*',
    'https://app.example/path',
    'https://user:password@app.example',
    'null',
    'https://app.example,',
  ])('rejects unsafe origins', (origins) => {
    expect(() => parseEnv({ CORS_ORIGINS: origins })).toThrow('CORS_ORIGINS');
  });
  it('requires explicit HTTPS origins in production', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow('CORS_ORIGINS');
    expect(() =>
      parseEnv({ NODE_ENV: 'production', CORS_ORIGINS: 'http://localhost:5173' }),
    ).toThrow('HTTPS');
    expect(() => parseEnv({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example' })).toThrow(
      'identity is required',
    );
  });
  it('does not echo invalid values in errors', () => {
    expect(() => parseEnv({ PORT: 'sensitive-value' })).toThrow(
      /^Invalid server configuration: PORT$/,
    );
  });
});

it('rejects partial identity settings and key material without echoing values', () => {
  expect(() => parseEnv({ SUPABASE_URL: 'https://identity.example' })).toThrow('identity fields');
  expect(() =>
    parseEnv({
      SUPABASE_URL: 'https://identity.example',
      SUPABASE_PUBLIC_KEY: 'sb_publishable_example_only',
      SESSION_DATABASE_URL: 'postgresql://leadsfam_runtime@database.example/app',
      SESSION_ACTIVE_KEY: 'new',
      SESSION_KEYS: 'not-a-secret-key',
    }),
  ).toThrow(/^Invalid server configuration: SESSION_KEYS$/);
});

it('requires public provider keys, verified database TLS and closed onboarding in production', () => {
  const configured = {
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://app.example',
    SUPABASE_URL: 'https://identity.example',
    SUPABASE_PUBLIC_KEY: 'sb_publishable_synthetic_example_only',
    SESSION_DATABASE_URL: 'postgresql://leadsfam_runtime@database.example/app?sslmode=verify-full',
    SESSION_ACTIVE_KEY: 'v1',
    SESSION_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 1).toString('base64') }),
  };
  expect(parseEnv(configured).identity?.onboardingEnabled).toBe(false);
  expect(() =>
    parseEnv({ ...configured, SUPABASE_PUBLIC_KEY: 'sb_secret_synthetic_example_only' }),
  ).toThrow('identity security settings');
  expect(() =>
    parseEnv({
      ...configured,
      SESSION_DATABASE_URL: 'postgresql://leadsfam_runtime@database.example/app',
    }),
  ).toThrow('identity security settings');
  expect(() => parseEnv({ ...configured, ALLOW_ORG_CREATION: 'true' })).toThrow(
    'identity security settings',
  );
});
