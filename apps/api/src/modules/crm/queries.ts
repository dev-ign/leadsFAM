import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  crmQuerySchema,
  activityQuerySchema,
  contactSchema,
  leadSchema,
  activitySchema,
  orgParamsSchema,
  resourceParamsSchema,
} from '@leadops/shared';
import type { SessionStore } from '../identity/sessions.js';
import { requireApplication, validated } from '../identity/routes.js';
import { IdentityFailure } from '../identity/failure.js';
import { OrganizationService } from '../organizations/service.js';
import { CursorCodec, positionSchema } from './cursors.js';

export function registerQueries(app: FastifyInstance, store: SessionStore, key?: string) {
  const service = new OrganizationService(store),
    codec = key ? new CursorCodec(key) : undefined;
  const context = async (request: FastifyRequest) => {
    const { org } = validated(orgParamsSchema, { org: (request.params as { org?: unknown }).org });
    const ctx = await service.authorize(requireApplication(request), org, 'read', request.id);
    if (!codec) throw new IdentityFailure(503, 'CURSOR_UNAVAILABLE');
    return { ctx, codec };
  };
  for (const [kind, schema] of [
    ['contacts', contactSchema],
    ['leads', leadSchema],
  ] as const) {
    app.get(`/organizations/:org/${kind}`, async (request) => {
      const { ctx, codec } = await context(request),
        { cursor, ...query } = validated(crmQuerySchema, request.query);
      const scope = { org: ctx.organization.id, user: ctx.caller.tokens.userId, kind, query };
      const position = cursor ? codec.decode(scope, cursor) : undefined;
      const result = z
        .strictObject({ items: z.array(schema).max(100), next: positionSchema.nullable() })
        .parse(
          await service.rpc(
            ctx.caller,
            'crm_query',
            {
              p_org: ctx.organization.id,
              p_kind: kind,
              p_query: query,
              ...(position ? { p_after: position } : {}),
            },
            request.id,
          ),
        );
      return { items: result.items, cursor: result.next ? codec.encode(scope, result.next) : null };
    });
    app.get(`/organizations/:org/${kind}/:id/activity`, async (request) => {
      const { ctx, codec } = await context(request),
        { id } = validated(resourceParamsSchema, request.params),
        { cursor, ...query } = validated(activityQuerySchema, request.query);
      const scope = {
        org: ctx.organization.id,
        user: ctx.caller.tokens.userId,
        kind: `${kind}-activity:${id}`,
        query,
      };
      const position = cursor ? codec.decode(scope, cursor) : undefined;
      const result = z
        .strictObject({ items: z.array(activitySchema).max(100), next: positionSchema.nullable() })
        .parse(
          await service.rpc(
            ctx.caller,
            'crm_activity',
            {
              p_org: ctx.organization.id,
              p_kind: kind === 'leads' ? 'lead' : 'contact',
              p_id: id,
              p_size: query.pageSize,
              ...(position ? { p_after: position } : {}),
            },
            request.id,
          ),
        );
      return { items: result.items, cursor: result.next ? codec.encode(scope, result.next) : null };
    });
  }
}
