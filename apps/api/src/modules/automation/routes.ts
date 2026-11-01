import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AutomationDatabase } from '@leadops/database';
import {
  automationOverviewSchema,
  ingestionSchema,
  ingestionResultSchema,
  integrationCreateSchema,
  integrationSchema,
  workflowSaveSchema,
  workflowSchema,
  orgParamsSchema,
  resourceParamsSchema,
  crmVersionSchema,
} from '@leadops/shared';
import { requireApplication, validated } from '../identity/routes.js';
import { IdentityFailure } from '../identity/failure.js';
import type { SessionStore } from '../identity/sessions.js';
import { OrganizationService } from '../organizations/service.js';
import { normalizeContact } from '../crm/normalize.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = () => `lf_ing_${randomBytes(32).toString('base64url')}`;
export function registerAutomationManagement(app: FastifyInstance, store: SessionStore) {
  const service = new OrganizationService(store),
    base = '/organizations/:org';
  app.get(`${base}/automations`, async (request) => {
    const { org } = validated(orgParamsSchema, request.params);
    return automationOverviewSchema.parse(
      await service.rpc(
        requireApplication(request),
        'automation_overview',
        { p_org: org },
        request.id,
      ),
    );
  });
  app.post(`${base}/automation-jobs/:id/retry`, async (request) => {
    const { org, id } = validated(resourceParamsSchema, request.params),
      { version } = validated(z.strictObject({ version: z.int().nonnegative() }), request.body);
    return z.strictObject({ id: z.uuid(), state: z.literal('retryable') }).parse(
      await service.rpc(
        requireApplication(request),
        'automation_manage',
        {
          p_org: org,
          p_kind: 'job',
          p_action: 'retry',
          p_id: id,
          p_version: version,
          p_data: {},
        },
        request.id,
      ),
    );
  });
  app.post(`${base}/integrations`, async (request) => {
    const { org } = validated(orgParamsSchema, request.params),
      input = validated(integrationCreateSchema, request.body),
      secret = credential();
    const integration = integrationSchema.parse(
      await service.rpc(
        requireApplication(request),
        'automation_manage',
        {
          p_org: org,
          p_kind: 'integration',
          p_action: 'create',
          p_data: { ...input, credentialHash: hash(secret) },
        },
        request.id,
      ),
    );
    return { integration, credential: secret };
  });
  app.post(`${base}/integrations/:id/:action`, async (request) => {
    const { org, id, action } = validated(
        resourceParamsSchema.extend({ action: z.enum(['active', 'paused', 'revoked', 'rotate']) }),
        request.params,
      ),
      { version } = validated(crmVersionSchema, request.body);
    const secret = action === 'rotate' ? credential() : null;
    const integration = integrationSchema.parse(
      await service.rpc(
        requireApplication(request),
        'automation_manage',
        {
          p_org: org,
          p_kind: 'integration',
          p_action: action,
          p_id: id,
          p_version: version,
          p_data: secret ? { credentialHash: hash(secret) } : {},
        },
        request.id,
      ),
    );
    return secret ? { integration, credential: secret } : { integration };
  });
  app.post(`${base}/automations`, async (request) => {
    const { org } = validated(orgParamsSchema, request.params),
      input = validated(workflowSaveSchema.omit({ version: true }), request.body);
    return workflowSchema.parse(
      await service.rpc(
        requireApplication(request),
        'automation_manage',
        { p_org: org, p_kind: 'workflow', p_action: 'save', p_data: input },
        request.id,
      ),
    );
  });
  app.put(`${base}/automations/:id`, async (request) => {
    const { org, id } = validated(resourceParamsSchema, request.params),
      { version, ...input } = validated(
        workflowSaveSchema.required({ version: true }),
        request.body,
      );
    return workflowSchema.parse(
      await service.rpc(
        requireApplication(request),
        'automation_manage',
        {
          p_org: org,
          p_kind: 'workflow',
          p_action: 'save',
          p_id: id,
          p_version: version,
          p_data: input,
        },
        request.id,
      ),
    );
  });
  app.post(`${base}/automations/:id/:action`, async (request) => {
    const { org, id, action } = validated(
        resourceParamsSchema.extend({ action: z.enum(['publish', 'pause']) }),
        request.params,
      ),
      { version } = validated(crmVersionSchema, request.body);
    return workflowSchema.parse(
      await service.rpc(
        requireApplication(request),
        'automation_manage',
        {
          p_org: org,
          p_kind: 'workflow',
          p_action: action,
          p_id: id,
          p_version: version,
          p_data: {},
        },
        request.id,
      ),
    );
  });
}

// Registered outside the human-session/CSRF scope. Public browser origins are
// explicitly rejected; a trusted backend must hold the integration credential.
export function registerIngress(app: FastifyInstance, databaseUrl?: string) {
  const db = databaseUrl ? new AutomationDatabase(databaseUrl, 'ingress') : null;
  if (db) {
    app.addHook('onReady', () => db.start());
    app.addHook('onClose', () => db.close());
  }
  app.post(
    '/ingress/v1/leads',
    { bodyLimit: 16 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      if (request.headers.origin || request.headers.cookie)
        throw new IdentityFailure(403, 'SERVER_INTEGRATION_REQUIRED');
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
        throw new IdentityFailure(415, 'UNSUPPORTED_MEDIA_TYPE');
      const authorization = request.headers.authorization;
      if (!authorization || !/^Bearer lf_ing_[A-Za-z0-9_-]{43}$/.test(authorization))
        throw new IdentityFailure(401, 'CREDENTIALS_REJECTED');
      const input = validated(ingestionSchema, request.body);
      const normalized = {
        ...input,
        contact:
          input.contact.mode === 'create'
            ? { mode: 'create' as const, data: normalizeContact(input.contact.data) }
            : input.contact,
      };
      if (!db) throw new IdentityFailure(503, 'INGESTION_UNAVAILABLE');
      try {
        return ingestionResultSchema.parse(
          await db.ingest(hash(authorization.slice(7)), normalized, request.id),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const mapping: Record<string, [number, string]> = {
          credentials_rejected: [401, 'CREDENTIALS_REJECTED'],
          idempotency_conflict: [409, 'IDEMPOTENCY_CONFLICT'],
          duplicate_review_required: [409, 'DUPLICATE_REVIEW_REQUIRED'],
          rate_limited: [429, 'RATE_LIMITED'],
          not_found: [404, 'NOT_FOUND'],
          source_unavailable: [409, 'SOURCE_UNAVAILABLE'],
          invalid_fields: [422, 'INVALID_FIELDS'],
        };
        const [status, code] = mapping[message] ?? [503, 'INGESTION_UNAVAILABLE'];
        throw new IdentityFailure(status, code);
      }
    },
  );
}
