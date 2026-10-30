import { describe, expect, it } from 'vitest';
import { healthResponseSchema, apiErrorSchema } from '../src/index.js';

describe('wire contracts', () => {
  it('rejects unknown fields and invalid health payloads received over HTTP', () => {
    expect(
      healthResponseSchema.safeParse({ status: 'ok', service: 'leadops-api', secret: 'unexpected' })
        .success,
    ).toBe(false);
    expect(
      healthResponseSchema.safeParse({ status: 'unavailable', service: 'leadops-api' }).success,
    ).toBe(false);
  });
  it('requires a correlation identifier on safe error envelopes', () => {
    expect(
      apiErrorSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'Route not found.' } })
        .success,
    ).toBe(false);
  });
});
