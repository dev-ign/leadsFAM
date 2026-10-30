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
    expect(
      parseEnv({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example' }).corsOrigins,
    ).toEqual(['https://app.example']);
  });
  it('does not echo invalid values in errors', () => {
    expect(() => parseEnv({ PORT: 'sensitive-value' })).toThrow(
      /^Invalid server configuration: PORT$/,
    );
  });
});
