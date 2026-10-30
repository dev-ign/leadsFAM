import { describe, expect, it } from 'vitest';
import { contactInputSchema } from '@leadops/shared';
import { normalizeContact } from '../src/modules/crm/normalize.js';

describe('conservative contact channels', () => {
  const input = { kind: 'person', displayName: 'Synthetic' };
  it('normalizes email without provider-specific dot or plus rewriting', () => {
    expect(
      normalizeContact(contactInputSchema.parse({ ...input, emails: ['A.B+Tag@example.test'] }))
        .emails[0]?.normalized,
    ).toBe('a.b+tag@example.test');
  });
  it('requires country context before matching local phone input', () => {
    expect(
      normalizeContact(
        contactInputSchema.parse({ ...input, phones: [{ value: '(202) 555-0123' }] }),
      ).phones[0]?.normalized,
    ).toBeNull();
    expect(
      normalizeContact(
        contactInputSchema.parse({ ...input, phones: [{ value: '(202) 555-0123', region: 'US' }] }),
      ).phones[0]?.normalized,
    ).toBe('+12025550123');
  });
  it('rejects invalid international numbers and extensions rather than extracting a substring', () => {
    for (const value of ['+1 123', '+1 202 555 0123 ext 5', 'call +1 202 555 0123']) {
      expect(() =>
        normalizeContact(contactInputSchema.parse({ ...input, phones: [{ value, region: 'US' }] })),
      ).toThrow();
    }
  });
  it('rejects repeated normalized channels and invalid country codes', () => {
    expect(() =>
      normalizeContact(
        contactInputSchema.parse({ ...input, emails: ['a@example.test', 'A@example.test'] }),
      ),
    ).toThrow();
    expect(() =>
      normalizeContact(
        contactInputSchema.parse({ ...input, phones: [{ value: '2025550123', region: 'ZZ' }] }),
      ),
    ).toThrow();
  });
  it('bounds channels and requires company identity', () => {
    expect(
      contactInputSchema.safeParse({ ...input, emails: Array(4).fill('a@example.test') }).success,
    ).toBe(false);
    expect(contactInputSchema.safeParse({ ...input, kind: 'company' }).success).toBe(false);
  });
});
