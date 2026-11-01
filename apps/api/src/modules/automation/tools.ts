import { z } from 'zod';
import { activityToolArguments, claimedJobSchema, jobOutcomeSchema } from '@leadops/shared';
import type { AutomationDatabase } from '@leadops/database';

export const toolRegistry = {
  'activities.create': {
    name: 'activities.create',
    version: 1,
    description: 'Record a bounded internal activity on the triggering lead.',
    input: activityToolArguments,
    output: z.strictObject({ activityId: z.uuid() }),
    permission: 'crm_manage',
    sideEffect: 'internal_mutation',
    idempotency: 'run_and_step',
    deadlineMs: 5000,
  },
} as const;
const proposal = z.strictObject({
  name: z.literal('activities.create'),
  version: z.literal(1),
  arguments: activityToolArguments,
});
export function validateToolProposal(input: unknown) {
  return proposal.parse(input);
}

// Authoritative arguments/context come from the persisted immutable revision.
// No public endpoint accepts a job token or model-selected execution context.
// The DB validates current authority, the lease, schemas, ownership and policy,
// executes CRM activity + audit, then fences completion in the same transaction.
export async function executeClaimedJob(db: AutomationDatabase, input: unknown) {
  const claim = claimedJobSchema.parse(input);
  if (Date.parse(claim.leaseExpiresAt) <= Date.now()) throw new Error('Lease expired');
  return jobOutcomeSchema.parse(await db.execute(claim.id, claim.token, claim.generation));
}
