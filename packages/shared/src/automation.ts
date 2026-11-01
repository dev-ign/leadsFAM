import { z } from 'zod';
import { contactInputSchema, leadFieldsSchema } from './crm.js';

export const ingestionSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  externalEventId: z.string().trim().min(1).max(160),
  contact: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('existing'), id: z.uuid() }),
    z.strictObject({ mode: z.literal('create'), data: contactInputSchema }),
  ]),
  lead: leadFieldsSchema,
  metadata: z
    .strictObject({
      formId: z.string().max(80).optional(),
      eventKind: z.enum(['inquiry', 'waitlist', 'booking']).optional(),
    })
    .default({}),
});
export const ingestionResultSchema = z.strictObject({
  receiptId: z.uuid(),
  leadId: z.uuid(),
  contactId: z.uuid(),
  correlationId: z.uuid(),
  state: z.literal('succeeded'),
  replayed: z.boolean(),
});
export const activityToolArguments = z.strictObject({ message: z.string().trim().min(1).max(300) });
export const workflowConditionSchema = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('sourceId'), equals: z.uuid() }),
  z.strictObject({
    field: z.literal('status'),
    equals: z.enum(['new', 'in_progress', 'qualified', 'closed']),
  }),
]);
export const workflowDefinitionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    trigger: z.literal('lead.created'),
    conditions: z.array(workflowConditionSchema).max(3),
    steps: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
          tool: z.literal('activities.create'),
          version: z.literal(1),
          arguments: activityToolArguments,
        }),
      )
      .min(1)
      .max(3),
  })
  .refine((v) => new Set(v.steps.map((s) => s.id)).size === v.steps.length);
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export const workflowSaveSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  definition: workflowDefinitionSchema,
  version: z.int().positive().optional(),
});
export const integrationCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  sourceId: z.uuid().optional(),
});
const stamp = z.iso.datetime({ offset: true });
export const integrationSchema = z.strictObject({
  id: z.uuid(),
  organization_id: z.uuid(),
  type: z.literal('first_party'),
  name: z.string().max(80),
  status: z.enum(['active', 'paused', 'revoked']),
  source_id: z.uuid().nullable(),
  expires_at: stamp,
  created_by: z.uuid(),
  authorized_by: z.uuid(),
  version: z.int().positive(),
  created_at: stamp,
  updated_at: stamp,
});
export const integrationCredentialSchema = z.strictObject({
  integration: integrationSchema,
  credential: z.string().regex(/^lf_ing_[A-Za-z0-9_-]{43}$/),
});
export const workflowSchema = z.strictObject({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string().max(80),
  status: z.enum(['draft', 'active', 'paused']),
  version: z.int().positive(),
  published_version: z.int().positive().nullable(),
  created_by: z.uuid(),
  created_at: stamp,
  updated_at: stamp,
  // Preserve unsupported future definitions. The guided editor explicitly checks
  // capabilities before allowing edits; it must never project unknown fields away.
  definition: z.record(z.string(), z.unknown()),
});
export type Workflow = z.infer<typeof workflowSchema>;
export function guidedWorkflowSupport(definition: unknown) {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (
    !parsed.success ||
    parsed.data.steps.length !== 1 ||
    new Set(parsed.data.conditions.map((c) => c.field)).size !== parsed.data.conditions.length
  )
    return {
      editable: false as const,
      reason:
        'This workflow uses features the guided builder cannot edit. Its configuration is preserved. Use a compatible editor to make changes.',
    };
  return { editable: true as const, definition: parsed.data };
}
const jobState = z.enum(['pending', 'claimed', 'retryable', 'completed', 'failed_terminal']);
export const automationOverviewSchema = z.strictObject({
  integrations: z.array(integrationSchema).max(25),
  workflows: z.array(workflowSchema).max(25),
  receipts: z
    .array(
      z.strictObject({
        id: z.uuid(),
        integration_id: z.uuid(),
        external_event_id: z.string().max(160),
        contact_id: z.uuid(),
        lead_id: z.uuid(),
        correlation_id: z.uuid(),
        created_at: stamp,
      }),
    )
    .max(25),
  jobs: z
    .array(
      z.strictObject({
        id: z.uuid(),
        type: z.enum(['dispatch', 'workflow']),
        state: jobState,
        generation: z.int().nonnegative(),
        attempts: z.int().nonnegative(),
        code: z.string().nullable(),
        run_at: stamp,
        created_at: stamp,
        correlation_id: z.uuid(),
      }),
    )
    .max(25),
  attempts: z
    .array(
      z.strictObject({
        id: z.uuid(),
        integration_id: z.uuid(),
        external_event_id: z.string().max(160),
        receipt_id: z.uuid().nullable(),
        correlation_id: z.uuid(),
        state: z.enum(['succeeded', 'replayed', 'rejected']),
        code: z.string().nullable(),
        created_at: stamp,
      }),
    )
    .max(25),
  runs: z
    .array(
      z.strictObject({
        id: z.uuid(),
        workflow_id: z.uuid(),
        workflow_version: z.int().positive(),
        event_id: z.uuid(),
        state: z.enum(['queued', 'succeeded', 'skipped', 'failed']),
        code: z.string().nullable(),
        started_at: stamp.nullable(),
        finished_at: stamp.nullable(),
        created_at: stamp,
        job_id: z.uuid(),
        job_state: jobState,
        attempts: z.int().nonnegative(),
        run_at: stamp,
        lead_id: z.uuid(),
        correlation_id: z.uuid(),
        completed_steps: z.int().nonnegative(),
      }),
    )
    .max(25),
  queue: z.strictObject({
    pending: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    oldestPendingAt: stamp.nullable(),
  }),
});
export type AutomationOverview = z.infer<typeof automationOverviewSchema>;
export const claimedJobSchema = z.strictObject({
  id: z.uuid(),
  type: z.enum(['dispatch', 'workflow']),
  schemaVersion: z.literal(1),
  token: z.uuid(),
  generation: z.int().positive(),
  leaseExpiresAt: stamp,
});
export const jobOutcomeSchema = z.strictObject({
  state: z.enum(['completed', 'retryable', 'failed_terminal']),
  completedSteps: z.int().nonnegative().optional(),
  code: z.string().max(40).optional(),
});
