import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AutomationDatabase } from '@leadops/database';
import {
  orgParamsSchema,
  resourceParamsSchema,
  messageDraftSchema,
  communicationMessageSchema,
  permissionInputSchema,
  suppressionInputSchema,
  communicationSettingsInput,
  communicationSettingsSchema,
  conversationPageSchema,
  communicationHistorySchema,
  communicationEventPageSchema,
  communicationEligibilitySchema,
  communicationChannel,
  communicationPurpose,
  providerEventSchema,
  okSchema,
} from '@leadops/shared';
import { OrganizationService } from '../organizations/service.js';
import { requireApplication, validated } from '../identity/routes.js';
import type { SessionStore } from '../identity/sessions.js';
import { IdentityFailure } from '../identity/failure.js';

const pageQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  contactId: z.uuid().optional(),
  leadId: z.uuid().optional(),
});
const approval = z.strictObject({ version: z.int().positive() });
export function registerCommunications(app: FastifyInstance, store: SessionStore) {
  const service = new OrganizationService(store),
    base = '/organizations/:org/communications';
  app.get(`${base}/settings`, async (request) => {
    const { org } = validated(orgParamsSchema, request.params);
    validated(z.strictObject({}), request.query);
    return communicationSettingsSchema.parse(
      await service.rpc(
        requireApplication(request),
        'communication_read',
        { p_org: org, p_kind: 'settings' },
        request.id,
      ),
    );
  });
  app.put(`${base}/settings`, async (request) => {
    const { org } = validated(orgParamsSchema, request.params),
      data = validated(communicationSettingsInput, request.body);
    return okSchema.parse(
      await service.rpc(
        requireApplication(request),
        'communication_manage',
        { p_org: org, p_action: 'settings', p_data: data },
        request.id,
      ),
    );
  });
  app.get(`${base}/conversations`, async (request) => {
    const { org } = validated(orgParamsSchema, request.params),
      query = validated(pageQuery, request.query);
    return conversationPageSchema.parse(
      await service.rpc(
        requireApplication(request),
        'communication_read',
        { p_org: org, p_kind: 'conversations', p_query: query },
        request.id,
      ),
    );
  });
  app.get(`${base}/conversations/:id`, async (request) => {
    const { org, id } = validated(resourceParamsSchema, request.params),
      query = validated(pageQuery.pick({ cursor: true }), request.query);
    return communicationHistorySchema.parse(
      await service.rpc(
        requireApplication(request),
        'communication_read',
        { p_org: org, p_kind: 'history', p_id: id, p_query: query },
        request.id,
      ),
    );
  });
  app.get(`${base}/messages/:id/events`, async (request) => {
    const { org, id } = validated(resourceParamsSchema, request.params),
      query = validated(pageQuery.pick({ cursor: true }), request.query);
    return communicationEventPageSchema.parse(
      await service.rpc(
        requireApplication(request),
        'communication_read',
        { p_org: org, p_kind: 'events', p_id: id, p_query: query },
        request.id,
      ),
    );
  });
  app.get(`${base}/contacts/:id/eligibility`, async (request) => {
    const { org, id } = validated(resourceParamsSchema, request.params),
      query = validated(
        z.strictObject({
          channel: communicationChannel,
          recipient: z.string().min(3).max(254),
          purpose: communicationPurpose,
        }),
        request.query,
      );
    return communicationEligibilitySchema.parse(
      await service.rpc(
        requireApplication(request),
        'communication_read',
        { p_org: org, p_kind: 'eligibility', p_id: id, p_query: query },
        request.id,
      ),
    );
  });
  app.get(`${base}/messages/:id`, async (request) => {
    const { org, id } = validated(resourceParamsSchema, request.params);
    validated(z.strictObject({}), request.query);
    return communicationMessageSchema.parse(
      await service.rpc(
        requireApplication(request),
        'communication_read',
        { p_org: org, p_kind: 'message', p_id: id },
        request.id,
      ),
    );
  });
  app.put(`${base}/messages/:id`, async (request) => {
    const { org, id } = validated(resourceParamsSchema, request.params),
      { version, ...data } = validated(
        messageDraftSchema.safeExtend({ version: z.int().positive().optional() }),
        request.body,
      );
    if (id !== data.id) throw new IdentityFailure(400, 'INVALID_REQUEST');
    return communicationMessageSchema.parse(
      await service.rpc(
        requireApplication(request),
        'communication_manage',
        {
          p_org: org,
          p_action: 'draft',
          p_id: id,
          ...(version ? { p_version: version } : {}),
          p_data: data,
        },
        request.id,
      ),
    );
  });
  for (const action of ['send', 'reconcile'] as const)
    app.post(`${base}/messages/:id/${action}`, async (request) => {
      const { org, id } = validated(resourceParamsSchema, request.params),
        { version } = validated(approval, request.body);
      return communicationMessageSchema.parse(
        await service.rpc(
          requireApplication(request),
          'communication_manage',
          { p_org: org, p_action: action, p_id: id, p_version: version },
          request.id,
        ),
      );
    });
  for (const [action, schema] of [
    ['permission', permissionInputSchema],
    ['suppression', suppressionInputSchema],
  ] as const)
    app.post(`${base}/${action}`, async (request) => {
      const { org } = validated(orgParamsSchema, request.params),
        data = validated<
          z.infer<typeof permissionInputSchema> | z.infer<typeof suppressionInputSchema>
        >(schema, request.body);
      return okSchema.parse(
        await service.rpc(
          requireApplication(request),
          'communication_manage',
          { p_org: org, p_action: action, p_data: data },
          request.id,
        ),
      );
    });
}

export function verifyMockWebhook(
  raw: Buffer,
  signature: unknown,
  timestamp: unknown,
  secret: string,
  now = Date.now(),
) {
  if (
    typeof signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    typeof timestamp !== 'string' ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    throw new IdentityFailure(401, 'CREDENTIALS_REJECTED');
  const expected = createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${timestamp}.`)
    .update(raw)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
    throw new IdentityFailure(401, 'CREDENTIALS_REJECTED');
}
// Encapsulation preserves exact raw bytes without changing the normal API parser.
export function registerCommunicationWebhooks(
  app: FastifyInstance,
  databaseUrl: string | undefined,
  secret: string | undefined,
  production: boolean,
) {
  void app.register(async (scoped) => {
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    const db =
      databaseUrl && secret && !production ? new AutomationDatabase(databaseUrl, 'ingress') : null;
    if (db) {
      scoped.addHook('onReady', () => db.start());
      scoped.addHook('onClose', () => db.close());
    }
    scoped.post(
      '/webhooks/mock/communications',
      { bodyLimit: 16 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
      async (request) => {
        if (!db || !secret) throw new IdentityFailure(503, 'INGESTION_UNAVAILABLE');
        if (request.headers.origin || request.headers.cookie)
          throw new IdentityFailure(403, 'SERVER_INTEGRATION_REQUIRED');
        if (!Buffer.isBuffer(request.body))
          throw new IdentityFailure(415, 'UNSUPPORTED_MEDIA_TYPE');
        verifyMockWebhook(
          request.body,
          request.headers['x-mock-signature'],
          request.headers['x-mock-timestamp'],
          secret,
        );
        let input: unknown;
        try {
          input = JSON.parse(request.body.toString('utf8'));
        } catch {
          throw new IdentityFailure(400, 'INVALID_REQUEST');
        }
        const event = validated(providerEventSchema, input);
        try {
          return okSchema.parse(await db.communicationEvent(event));
        } catch (error) {
          if (error instanceof Error && error.message === 'rate_limited')
            throw new IdentityFailure(429, 'RATE_LIMITED');
          throw new IdentityFailure(503, 'INGESTION_UNAVAILABLE');
        }
      },
    );
  });
}
