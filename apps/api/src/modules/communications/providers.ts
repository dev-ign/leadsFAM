import { z } from 'zod';
import { dispatchEnvelopeSchema, type DispatchEnvelope } from '@leadops/shared';

export const providerResultSchema = z.strictObject({
  state: z.enum(['accepted', 'delivered', 'failed', 'bounced', 'retryable', 'unknown']),
  reference: z
    .string()
    .regex(/^mock:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
});
export type ProviderResult = z.infer<typeof providerResultSchema>;
export interface CommunicationProvider {
  readonly identity: 'mock';
  readonly idempotent: boolean;
  send(envelope: DispatchEnvelope, signal: AbortSignal): Promise<ProviderResult>;
  reconcile(envelope: DispatchEnvelope, signal: AbortSignal): Promise<ProviderResult>;
}
// Only this typed error asserts that submission definitely did not happen.
export class UnsubmittedProviderError extends Error {
  constructor(readonly retryable: boolean) {
    super('Provider rejected before submission');
  }
}
export const mockProvider: CommunicationProvider = {
  identity: 'mock',
  idempotent: true,
  async send(input, signal) {
    signal.throwIfAborted();
    const envelope = dispatchEnvelopeSchema.parse(input);
    if (
      envelope.providerReference !== `mock:${envelope.id}` ||
      envelope.sender !==
        (envelope.channel === 'email' ? 'FreshNest <mock@example.test>' : '+15005550006')
    )
      throw new UnsubmittedProviderError(false);
    return { state: 'accepted', reference: envelope.providerReference };
  },
  async reconcile(input, signal) {
    signal.throwIfAborted();
    const envelope = dispatchEnvelopeSchema.parse(input);
    // Reserved synthetic destinations demonstrate terminal mock failures.
    const state =
      envelope.channel === 'email' && envelope.recipient === 'bounce@example.test'
        ? 'bounced'
        : envelope.channel === 'email' && envelope.recipient === 'fail@example.test'
          ? 'failed'
          : 'delivered';
    return { state, reference: envelope.providerReference };
  },
};
