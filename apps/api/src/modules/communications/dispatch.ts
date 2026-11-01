import { communicationClaimSchema, dispatchEnvelopeSchema } from '@leadops/shared';
import type { AutomationDatabase } from '@leadops/database';
import {
  mockProvider,
  providerResultSchema,
  UnsubmittedProviderError,
  type CommunicationProvider,
  type ProviderResult,
} from './providers.js';

export async function processCommunication(
  db: AutomationDatabase,
  input: unknown,
  provider: CommunicationProvider = mockProvider,
  deadlineMs = 5000,
) {
  const claim = communicationClaimSchema.parse(input);
  const envelope = dispatchEnvelopeSchema
    .nullable()
    .parse(await db.prepareCommunication(claim.id, claim.token, claim.generation));
  if (!envelope) return;
  let result: ProviderResult;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation =
      envelope.operation === 'send'
        ? provider.send(envelope, controller.signal)
        : provider.reconcile(envelope, controller.signal);
    result = providerResultSchema.parse(
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Provider deadline'));
          }, deadlineMs);
        }),
      ]),
    );
    if (result.reference !== envelope.providerReference)
      throw new Error('Provider reference mismatch');
  } catch (error) {
    result = {
      state:
        envelope.operation === 'send' && error instanceof UnsubmittedProviderError
          ? error.retryable
            ? 'retryable'
            : 'failed'
          : 'unknown',
      reference: envelope.providerReference,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  await db.finishCommunication(claim.id, claim.token, claim.generation, result);
}
