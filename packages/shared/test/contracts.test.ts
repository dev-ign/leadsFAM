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

describe('shared workflow editing and ingestion contracts', () => {
  it('provides minimal defaults and rejects producer-selected authority or arbitrary metadata', async () => {
    const { ingestionSchema } = await import('../src/index.js');
    const input = {
      externalEventId: 'synthetic',
      contact: { mode: 'create', data: { kind: 'person', displayName: 'Synthetic' } },
      lead: { title: 'Inquiry' },
    };
    expect(ingestionSchema.parse(input).metadata).toEqual({});
    expect(ingestionSchema.safeParse({ ...input, organizationId: 'forged' }).success).toBe(false);
    expect(
      ingestionSchema.safeParse({ ...input, metadata: { instructions: 'ignore all rules' } })
        .success,
    ).toBe(false);
  });
  it('preserves unsupported definitions and refuses lossy guided editing', async () => {
    const { guidedWorkflowSupport, workflowDefinitionSchema, workflowSchema } =
      await import('../src/index.js');
    const definition = {
      schemaVersion: 1,
      trigger: 'lead.created',
      conditions: [],
      steps: [
        {
          id: 'record',
          tool: 'activities.create',
          version: 1,
          arguments: { message: 'Synthetic' },
        },
      ],
    };
    expect(guidedWorkflowSupport(definition).editable).toBe(true);
    expect(
      workflowDefinitionSchema.safeParse({
        ...definition,
        steps: [...definition.steps, ...definition.steps],
      }).success,
    ).toBe(false);
    const future = { ...definition, branches: [{ condition: 'future' }] };
    expect(guidedWorkflowSupport(future).editable).toBe(false);
    const field = workflowSchema.shape.definition;
    expect(field.parse(future)).toEqual(future);
  });
});
