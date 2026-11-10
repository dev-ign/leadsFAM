import { describe, expect, it } from 'vitest';
import { validateToolProposal, toolRegistry } from '../src/modules/automation/tools.js';
import {
  disabledCommunications,
  mockCommunications,
  type OutboundIntent,
  type CommunicationPolicy,
} from '../src/modules/automation/communications.js';
describe('agent tool and communication boundaries', () => {
  it('accepts only a supported version and bounded arguments, never proposed authority', () => {
    const valid = {
      name: 'activities.create',
      version: 1,
      arguments: { message: 'Synthetic activity' },
    };
    expect(validateToolProposal(valid)).toEqual(valid);
    for (const input of [
      { ...valid, organizationId: 'forged' },
      { ...valid, actor: 'system' },
      { ...valid, name: 'sql.execute' },
      { ...valid, version: 2 },
      { ...valid, arguments: { message: 'test', leadId: 'foreign' } },
      { ...valid, arguments: { message: 'x'.repeat(301) } },
    ])
      expect(() => validateToolProposal(input)).toThrow();
    expect(toolRegistry['activities.create'].sideEffect).toBe('internal_mutation');
  });
  it('never sends through the disabled adapter and isolates mock consent by tenant, channel and purpose', async () => {
    const intent: OutboundIntent = {
      id: 'synthetic',
      organizationId: 'a',
      contactId: 'synthetic-contact',
      channel: 'sms',
      purpose: 'marketing',
      idempotencyKey: 'synthetic',
    };
    const policy: CommunicationPolicy = {
      organizationId: 'a',
      channel: 'sms',
      purpose: 'marketing',
      consent: 'granted',
      provenance: 'synthetic opt-in',
      recordedAt: '2026-10-30T00:00:00Z',
      suppressed: false,
    };
    expect((await disabledCommunications.send(intent, policy)).state).toBe('disabled');
    expect((await mockCommunications.send(intent, policy)).state).toBe('test_accepted');
    for (const change of [
      { organizationId: 'b' },
      { channel: 'email' as const },
      { purpose: 'transactional' as const },
      { consent: 'unknown' as const },
      { suppressed: true },
      { provenance: null },
    ])
      expect((await mockCommunications.send(intent, { ...policy, ...change })).state).toBe(
        'suppressed',
      );
  });
});

describe('Phase 04 mock provider and webhook trust boundaries', () => {
  it('validates exact raw bytes, rejects stale timestamps and forged signatures', async () => {
    const { createHmac } = await import('node:crypto');
    const { verifyMockWebhook } = await import('../src/modules/communications/routes.js');
    const secret = Buffer.alloc(32, 7).toString('base64'),
      raw = Buffer.from('{ "synthetic": true }'),
      timestamp = String(Math.floor(Date.now() / 1000));
    const sign = (body: Buffer, time: string) =>
      createHmac('sha256', Buffer.from(secret, 'base64'))
        .update(`${time}.`)
        .update(body)
        .digest('hex');
    expect(() => verifyMockWebhook(raw, sign(raw, timestamp), timestamp, secret)).not.toThrow();
    expect(() =>
      verifyMockWebhook(Buffer.from('{"synthetic":true}'), sign(raw, timestamp), timestamp, secret),
    ).toThrow();
    expect(() => verifyMockWebhook(raw, '0'.repeat(64), timestamp, secret)).toThrow();
    const stale = String(Number(timestamp) - 301);
    expect(() => verifyMockWebhook(raw, sign(raw, stale), stale, secret)).toThrow();
  });
  it('rejects unsupported live modes and malformed secrets without echoing inputs', async () => {
    const { parseCommunicationEnv } = await import('../src/config/env.js');
    expect(parseCommunicationEnv({})).toBeUndefined();
    for (const environment of [
      { COMMUNICATIONS_MODE: 'resend' },
      { OUTBOUND_LIVE_ENABLED: 'true' },
      { MOCK_WEBHOOK_SECRET: 'private-secret' },
    ])
      expect(() => parseCommunicationEnv(environment)).toThrow(
        /Invalid communication configuration/,
      );
  });
  it('strictly validates drafts, channels and actor/provider substitution', async () => {
    const { messageDraftSchema, providerEventSchema } = await import('@leadops/shared');
    const input = {
      id: crypto.randomUUID(),
      contactId: crypto.randomUUID(),
      leadId: null,
      channel: 'email',
      purpose: 'transactional',
      recipient: 'test@example.test',
      subject: 'Synthetic',
      body: 'A test message',
    };
    expect(messageDraftSchema.safeParse(input).success).toBe(true);
    for (const change of [
      { sender: 'forged@example.test' },
      { organizationId: crypto.randomUUID() },
      { body: '' },
      { recipient: 'invalid' },
      { channel: 'sms', recipient: '+12025550123', subject: '', body: 'x'.repeat(1601) },
    ])
      expect(messageDraftSchema.safeParse({ ...input, ...change }).success).toBe(false);
    expect(
      providerEventSchema.safeParse({
        eventId: 'fixture',
        reference: `mock:${'-'.repeat(36)}`,
        channel: 'email',
        type: 'delivered',
      }).success,
    ).toBe(false);
    expect(
      providerEventSchema.safeParse({
        eventId: 'fixture',
        reference: `mock:${input.id}`,
        channel: 'email',
        type: 'delivered',
        organizationId: 'forged',
      }).success,
    ).toBe(false);
  });
});

describe('Phase 07 inbound contract', () => {
  it('accepts bounded plain customer text and rejects proposed authority and invalid Unicode', async () => {
    const { inboundMessageInput, integrationCreateSchema } = await import('@leadops/shared');
    const input = {
      eventId: 'synthetic:1',
      channel: 'email',
      sender: 'customer@example.test',
      body: '  Actually three bedrooms.\r\nThank you. 🙂  ',
    };
    expect(inboundMessageInput.parse(input).body).toBe(input.body);
    for (const extra of [
      { organizationId: crypto.randomUUID() },
      { contactId: crypto.randomUUID() },
      { leadId: crypto.randomUUID() },
      { approve: true },
      { body: '\0' },
      { body: '\ud800' },
      { body: 'x'.repeat(4001) },
      { channel: 'sms', sender: '+12025550123', body: 'x'.repeat(1601) },
    ])
      expect(inboundMessageInput.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(integrationCreateSchema.parse({ name: 'Existing intake' }).capability).toBe(
      'lead_intake',
    );
  });
  it('derives separate rotating server-only signing credentials for each mock connector', async () => {
    const { deriveMockInboundCredential } = await import('../src/modules/automation/routes.js');
    const root = Buffer.alloc(32, 9).toString('base64'),
      id = crypto.randomUUID();
    const key = deriveMockInboundCredential(root, id, 1);
    expect(key).toMatch(/^lf_inb_[A-Za-z0-9_-]{43}$/);
    expect(deriveMockInboundCredential(root, id, 1)).toBe(key);
    expect(deriveMockInboundCredential(root, id, 2)).not.toBe(key);
    expect(deriveMockInboundCredential(root, crypto.randomUUID(), 1)).not.toBe(key);
  });
});
