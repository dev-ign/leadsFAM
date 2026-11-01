// Disabled provider-neutral boundary. Contact existence never implies consent.
export interface CommunicationPolicy {
  organizationId: string;
  channel: 'email' | 'sms';
  purpose: 'transactional' | 'marketing';
  consent: 'unknown' | 'granted' | 'denied';
  provenance: string | null;
  recordedAt: string | null;
  suppressed: boolean;
}
export interface OutboundIntent {
  id: string;
  organizationId: string;
  channel: 'email' | 'sms';
  purpose: 'transactional' | 'marketing';
  contactId: string;
  idempotencyKey: string;
}
export interface CommunicationAdapter {
  readonly mode: 'disabled' | 'test';
  send(
    intent: OutboundIntent,
    policy: CommunicationPolicy,
  ): Promise<{
    state: 'disabled' | 'suppressed' | 'test_accepted';
    providerReference: string | null;
  }>;
  lookupDeliveryStatus(reference: string): Promise<'unknown' | 'test_accepted'>;
}
export function communicationAllowed(intent: OutboundIntent, policy: CommunicationPolicy) {
  return (
    intent.organizationId === policy.organizationId &&
    intent.channel === policy.channel &&
    intent.purpose === policy.purpose &&
    policy.consent === 'granted' &&
    Boolean(policy.provenance && policy.recordedAt) &&
    !policy.suppressed
  );
}
export const disabledCommunications: CommunicationAdapter = {
  mode: 'disabled',
  async send() {
    return { state: 'disabled', providerReference: null };
  },
  async lookupDeliveryStatus() {
    return 'unknown';
  },
};
export const mockCommunications: CommunicationAdapter = {
  mode: 'test',
  async send(intent, policy) {
    return communicationAllowed(intent, policy)
      ? { state: 'test_accepted', providerReference: `test:${intent.idempotencyKey}` }
      : { state: 'suppressed', providerReference: null };
  },
  async lookupDeliveryStatus(reference) {
    return reference.startsWith('test:') ? 'test_accepted' : 'unknown';
  },
};
// A signed webhook adapter must verify bounded raw bytes BEFORE parsing, use
// its provider's algorithm/timestamp/replay rules, and return a normalized event.
export interface InboundWebhookAdapter {
  verifyAndNormalize(
    raw: Uint8Array,
    headers: Readonly<Record<string, string>>,
    deadline: AbortSignal,
  ): Promise<unknown>;
}
