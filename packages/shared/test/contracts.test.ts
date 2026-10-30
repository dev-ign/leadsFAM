import { describe, expect, it } from 'vitest';
import { healthResponseSchema, apiErrorSchema, can } from '../src/index.js';

describe('wire contracts', () => {
  it('keeps CRM write permission separate from administration and import permission', () => {
    expect(can('member', 'crm_write')).toBe(true);
    expect(can('member', 'crm_manage')).toBe(false);
    expect(can('member', 'crm_import')).toBe(false);
    for (const role of ['owner', 'admin'] as const) {
      expect(can(role, 'crm_manage')).toBe(true);
      expect(can(role, 'crm_import')).toBe(true);
    }
  });
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
