import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  aiHistorySchema,
  aiRequestInput,
  aiRunSchema,
  aiSettingsInput,
  aiSettingsSchema,
  communicationMessageSchema,
  okSchema,
  orgParamsSchema,
  resourceParamsSchema,
} from '@leadops/shared';
import { OrganizationService } from '../organizations/service.js';
import { requireApplication, validated } from '../identity/routes.js';
import type { SessionStore } from '../identity/sessions.js';

export function registerAi(app: FastifyInstance, store: SessionStore) {
  const service = new OrganizationService(store),
    base = '/organizations/:org/ai';
  app.get(`${base}/settings`, async (request) => {
    const { org } = validated(orgParamsSchema, request.params);
    validated(z.strictObject({}), request.query);
    return aiSettingsSchema.parse(
      await service.rpc(
        requireApplication(request),
        'ai_read',
        { p_org: org, p_kind: 'settings' },
        request.id,
      ),
    );
  });
  app.put(`${base}/settings`, async (request) => {
    const { org } = validated(orgParamsSchema, request.params);
    const { version, ...data } = validated(
      aiSettingsInput.extend({ version: z.int().positive() }),
      request.body,
    );
    return okSchema.parse(
      await service.rpc(
        requireApplication(request),
        'ai_manage',
        { p_org: org, p_action: 'settings', p_version: version, p_data: data },
        request.id,
      ),
    );
  });
  app.get(`${base}/history`, async (request) => {
    const { org } = validated(orgParamsSchema, request.params);
    const { leadId, ...query } = validated(
      z.strictObject({ leadId: z.uuid().optional(), cursor: z.string().max(160).optional() }),
      request.query,
    );
    return aiHistorySchema.parse(
      await service.rpc(
        requireApplication(request),
        'ai_read',
        { p_org: org, p_kind: 'history', ...(leadId ? { p_id: leadId } : {}), p_query: query },
        request.id,
      ),
    );
  });
  app.put(`${base}/requests/:id`, async (request) => {
    const { org, id } = validated(resourceParamsSchema, request.params);
    const data = validated(aiRequestInput, request.body);
    return aiRunSchema.parse(
      await service.rpc(
        requireApplication(request),
        'ai_manage',
        { p_org: org, p_action: 'request', p_id: id, p_data: data },
        request.id,
      ),
    );
  });
  app.post(`${base}/requests/:id/draft`, async (request) => {
    const { org, id } = validated(resourceParamsSchema, request.params);
    const data = validated(
      z.strictObject({
        recipient: z.string().min(3).max(254),
        subject: z.string().trim().max(200),
        body: z.string().trim().min(1).max(1600),
      }),
      request.body,
    );
    return communicationMessageSchema.parse(
      await service.rpc(
        requireApplication(request),
        'ai_manage',
        { p_org: org, p_action: 'save_draft', p_id: id, p_data: data },
        request.id,
      ),
    );
  });
}
