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
