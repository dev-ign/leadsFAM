import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  contactInputSchema,
  contactUpdateSchema,
  contactSchema,
  leadSchema,
  leadUpdateSchema,
  leadTransitionSchema,
  leadAssignmentSchema,
  crmVersionSchema,
  sourceInputSchema,
  sourceUpdateSchema,
  sourceSchema,
  resourceParamsSchema,
  orgParamsSchema,
  crmIdempotencyKeySchema,
} from '@leadops/shared';
import type { SessionStore } from '../identity/sessions.js';
import { requireApplication, validated } from '../identity/routes.js';
import { OrganizationService } from '../organizations/service.js';
import { normalizeContact } from './normalize.js';
import { registerImports } from './imports.js';
import { registerQueries } from './queries.js';

export function registerCrm(app: FastifyInstance, store: SessionStore, cursorKey?: string) {
  registerImports(app, store);
  registerQueries(app, store, cursorKey);
  const service = new OrganizationService(store);
  const context = async (request: FastifyRequest) => {
    const { org } = validated(orgParamsSchema, { org: (request.params as { org?: unknown }).org });
    return service.authorize(requireApplication(request), org, 'read', request.id);
  };
  const base = '/organizations/:org';
  app.post(`${base}/contacts/candidates`, async (request) => {
    const ctx = await context(request),
      input = normalizeContact(validated(contactInputSchema, request.body));
    return z
      .array(contactSchema)
      .max(10)
      .parse(
        await service.rpc(
          ctx.caller,
          'crm_candidates',
          { p_org: ctx.organization.id, p_data: input },
          request.id,
        ),
      );
  });
  app.post(`${base}/contacts`, async (request) => {
    const ctx = await context(request),
      input = normalizeContact(validated(contactInputSchema, request.body)),
      key = validated(crmIdempotencyKeySchema, request.headers['idempotency-key']);
    return contactSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_save_contact',
        { p_org: ctx.organization.id, p_action: 'create', p_data: input, p_key: key },
        request.id,
      ),
    );
  });
  for (const [kind, schema] of [
    ['contacts', contactSchema],
    ['leads', leadSchema],
  ] as const) {
    app.get(`${base}/${kind}/:id`, async (request) => {
      const ctx = await context(request),
        { id } = validated(resourceParamsSchema, request.params);
      return schema.parse(
        await service.rpc(
          ctx.caller,
          'crm_get',
          {
            p_org: ctx.organization.id,
            p_kind: kind === 'contacts' ? 'contact' : 'lead',
            p_id: id,
          },
          request.id,
        ),
      );
    });
    for (const action of ['archive', 'restore'] as const) {
      app.post(`${base}/${kind}/:id/${action}`, async (request) => {
        const ctx = await context(request),
          { id } = validated(resourceParamsSchema, request.params),
          { version } = validated(crmVersionSchema, request.body);
        const result =
          kind === 'contacts'
            ? await service.rpc(
                ctx.caller,
                'crm_save_contact',
                {
                  p_org: ctx.organization.id,
                  p_action: action,
                  p_id: id,
                  p_version: version,
                  p_data: {},
                },
                request.id,
              )
            : await service.rpc(
                ctx.caller,
                'crm_change_lead',
                {
                  p_org: ctx.organization.id,
                  p_action: action,
                  p_id: id,
                  p_version: version,
                  p_data: {},
                },
                request.id,
              );
        return schema.parse(result);
      });
    }
  }
  app.patch(`${base}/contacts/:id`, async (request) => {
    const ctx = await context(request),
      { id } = validated(resourceParamsSchema, request.params),
      input = validated(contactUpdateSchema, request.body);
    return contactSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_save_contact',
        {
          p_org: ctx.organization.id,
          p_action: 'update',
          p_id: id,
          p_version: input.version,
          p_data: normalizeContact(input.contact),
        },
        request.id,
      ),
    );
  });
  app.patch(`${base}/leads/:id`, async (request) => {
    const ctx = await context(request),
      { id } = validated(resourceParamsSchema, request.params),
      input = validated(leadUpdateSchema, request.body);
    return leadSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_change_lead',
        {
          p_org: ctx.organization.id,
          p_action: 'update',
          p_id: id,
          p_version: input.version,
          p_data: input.lead,
        },
        request.id,
      ),
    );
  });
  app.post(`${base}/leads/:id/transitions`, async (request) => {
    const ctx = await context(request),
      { id } = validated(resourceParamsSchema, request.params),
      { version, ...data } = validated(leadTransitionSchema, request.body);
    return leadSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_change_lead',
        {
          p_org: ctx.organization.id,
          p_action: 'transition',
          p_id: id,
          p_version: version,
          p_data: data,
        },
        request.id,
      ),
    );
  });
  app.put(`${base}/leads/:id/assignee`, async (request) => {
    const ctx = await context(request),
      { id } = validated(resourceParamsSchema, request.params),
      { version, ...data } = validated(leadAssignmentSchema, request.body);
    return leadSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_change_lead',
        {
          p_org: ctx.organization.id,
          p_action: 'assign',
          p_id: id,
          p_version: version,
          p_data: data,
        },
        request.id,
      ),
    );
  });
  app.get(`${base}/lead-sources`, async (request) => {
    const ctx = await context(request);
    return z
      .array(sourceSchema)
      .parse(
        await service.rpc(ctx.caller, 'crm_sources', { p_org: ctx.organization.id }, request.id),
      );
  });
  app.post(`${base}/lead-sources`, async (request) => {
    const ctx = await context(request),
      input = validated(sourceInputSchema, request.body);
    return sourceSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_sources',
        { p_org: ctx.organization.id, p_data: input },
        request.id,
      ),
    );
  });
  app.patch(`${base}/lead-sources/:id`, async (request) => {
    const ctx = await context(request),
      { id } = validated(resourceParamsSchema, request.params),
      input = validated(sourceUpdateSchema, request.body);
    return sourceSchema.parse(
      await service.rpc(
        ctx.caller,
        'crm_sources',
        { p_org: ctx.organization.id, p_id: id, p_version: input.version, p_data: input.source },
        request.id,
      ),
    );
  });
}
