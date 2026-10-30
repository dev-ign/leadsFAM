import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Json } from '@leadops/database';
import {
  can,
  csvPreviewInputSchema,
  csvPreviewSchema,
  contactSchema,
  importSubmissionSchema,
  importResultSchema,
  importStatusSchema,
  importJobsSchema,
  leadIntakeSchema,
  leadSchema,
  crmIdempotencyKeySchema,
  orgParamsSchema,
  resourceParamsSchema,
} from '@leadops/shared';
import type { SessionStore } from '../identity/sessions.js';
import { requireApplication, validated } from '../identity/routes.js';
import { IdentityFailure } from '../identity/failure.js';
import { OrganizationService } from '../organizations/service.js';
import { normalizeIntake, importIntake } from './intake.js';
import { parseCsv, csvColumns } from './csv.js';

// Inputs originate in bounded JSON request bodies, then pass explicit contracts.
const json = (input: unknown): Json => JSON.parse(JSON.stringify(input)) as Json;

export function registerImports(app: FastifyInstance, store: SessionStore) {
  const service = new OrganizationService(store);
  const context = async (request: FastifyRequest, imports = true) => {
    const { org } = validated(orgParamsSchema, { org: (request.params as { org?: unknown }).org });
    const ctx = await service.authorize(requireApplication(request), org, 'read', request.id);
    if (imports && !can(ctx.organization.role, 'crm_import'))
      throw new IdentityFailure(403, 'FORBIDDEN');
    return ctx;
  };
  const base = '/organizations/:org';
  app.post(
    `${base}/lead-imports/columns`,
    { bodyLimit: 524288, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      await context(request);
      const input = validated(csvPreviewInputSchema.pick({ csv: true }), request.body);
      return { columns: csvColumns(input.csv) };
    },
  );
  app.post(`${base}/leads`, async (request) => {
    const ctx = await context(request, false),
      input = normalizeIntake(validated(leadIntakeSchema, request.body)),
      key = validated(crmIdempotencyKeySchema, request.headers['idempotency-key']);
    return leadSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_intake_manual',
        { p_org: ctx.organization.id, p_data: input, p_key: key },
        request.id,
      ),
    );
  });
  app.post(
    `${base}/lead-imports/preview`,
    { bodyLimit: 524288, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      // The session/Origin/CSRF hooks and this authority check precede CSV parsing.
      const ctx = await context(request),
        input = validated(csvPreviewInputSchema, request.body);
      const jobId = input.jobId ?? randomUUID();
      let manifest: z.infer<typeof importStatusSchema>['deliveries'] = [];
      if (input.jobId) {
        try {
          manifest = importStatusSchema.parse(
            await service.rpc(
              ctx.caller,
              'crm_import_status',
              { p_org: ctx.organization.id, p_job: jobId },
              request.id,
            ),
          ).deliveries;
        } catch (error) {
          if (!(error instanceof IdentityFailure) || error.statusCode !== 404) throw error;
        }
      }
      const parsed = parseCsv(input.csv, input.mapping);
      const inputs = parsed.rows.map((row) =>
        row.normalized?.contact.mode === 'create' ? row.normalized.contact.data : null,
      );
      const candidates = z
        .array(z.array(contactSchema).max(10))
        .max(100)
        .parse(
          await service.rpc(
            ctx.caller,
            'crm_preview_candidates',
            { p_org: ctx.organization.id, p_inputs: json(inputs) },
            request.id,
          ),
        );
      const keys = inputs.map((contact) =>
        contact
          ? [
              `name:${contact.displayName.toLowerCase()}`,
              ...contact.emails.map((v) => `email:${v.normalized}`),
              ...contact.phones.filter((v) => v.normalized).map((v) => `phone:${v.normalized}`),
            ]
          : [],
      );
      return csvPreviewSchema.parse({
        jobId,
        columns: parsed.columns,
        rows: parsed.rows.map((row, i) => ({
          rowNumber: row.rowNumber,
          deliveryId:
            manifest.find((v) => v.rowNumber === row.rowNumber)?.deliveryId ?? randomUUID(),
          intake: row.intake,
          errorCode: row.errorCode,
          fields: row.fields,
          candidates: candidates[i] ?? [],
          duplicateRows: parsed.rows
            .filter((_, j) => j !== i && keys[j]?.some((key) => keys[i]?.includes(key)))
            .map((v) => v.rowNumber),
        })),
      });
    },
  );
  app.post(
    `${base}/lead-imports`,
    { bodyLimit: 524288, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const ctx = await context(request),
        input = validated(importSubmissionSchema, request.body);
      const rows = input.rows.map((row) => ({ ...row, intake: importIntake(row.intake) }));
      return importResultSchema.parse(
        await service.rpc(
          ctx.caller,
          'crm_import_execute',
          {
            p_org: ctx.organization.id,
            p_job: input.jobId,
            p_attempt: input.attemptId,
            p_rows: json(rows),
          },
          request.id,
        ),
      );
    },
  );
  app.get(`${base}/lead-imports`, async (request) => {
    const ctx = await context(request);
    return importJobsSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_import_status',
        { p_org: ctx.organization.id },
        request.id,
      ),
    );
  });
  app.get(`${base}/lead-imports/:id`, async (request) => {
    const ctx = await context(request),
      { id } = validated(resourceParamsSchema, request.params);
    return importStatusSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_import_status',
        { p_org: ctx.organization.id, p_job: id },
        request.id,
      ),
    );
  });
  app.get(`${base}/lead-imports/:id/attempts/:attempt`, async (request) => {
    const ctx = await context(request),
      params = validated(resourceParamsSchema.extend({ attempt: z.uuid() }), request.params);
    return importResultSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_import_status',
        { p_org: ctx.organization.id, p_job: params.id, p_attempt: params.attempt },
        request.id,
      ),
    );
  });
}
