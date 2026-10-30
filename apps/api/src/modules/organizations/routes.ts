import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  orgParamsSchema,
  organizationNameSchema,
  organizationSchema,
  organizationsSchema,
  membersSchema,
  memberParamsSchema,
  resourceParamsSchema,
  memberChangeSchema,
  invitationRequestSchema,
  invitationAcceptSchema,
  invitationsSchema,
  noteInputSchema,
  notesSchema,
  noteSchema,
  okSchema,
  invitationCreatedSchema,
  type Permission,
} from '@leadops/shared';
import { requireApplication, validated } from '../identity/routes.js';
import { hash, type SessionStore } from '../identity/sessions.js';
import { IdentityFailure } from '../identity/failure.js';
import { OrganizationService } from './service.js';

export function registerOrganizations(app: FastifyInstance, store: SessionStore) {
  const service = new OrganizationService(store);
  const context = async (request: FastifyRequest, permission: Permission = 'read') => {
    const { org } = validated(orgParamsSchema, { org: (request.params as { org?: unknown }).org });
    return service.authorize(requireApplication(request), org, permission, request.id);
  };
  app.get('/organizations', async (request) =>
    organizationsSchema.parse(
      await service.rpc(requireApplication(request), 'list_organizations', {}, request.id),
    ),
  );
  app.post(
    '/organizations',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request) => {
      const caller = requireApplication(request),
        input = validated(organizationNameSchema, request.body);
      if (!store.config.onboardingEnabled) throw new IdentityFailure(403, 'ONBOARDING_DISABLED');
      return organizationSchema.parse(
        await service.rpc(caller, 'create_organization', { p_name: input.name }, request.id),
      );
    },
  );
  app.get('/organizations/:org', async (request) => (await context(request)).organization);
  app.patch('/organizations/:org', async (request) => {
    const input = validated(organizationNameSchema, request.body),
      ctx = await context(request, 'settings');
    return organizationSchema.parse(
      await service.rpc(
        ctx.caller,
        'update_organization',
        { p_org: ctx.organization.id, p_name: input.name },
        request.id,
      ),
    );
  });
  app.get('/organizations/:org/members', async (request) => {
    const ctx = await context(request);
    return membersSchema.parse(
      await service.rpc(ctx.caller, 'list_members', { p_org: ctx.organization.id }, request.id),
    );
  });
  app.patch('/organizations/:org/members/:user', async (request) => {
    const params = validated(memberParamsSchema, request.params),
      input = validated(memberChangeSchema, request.body),
      ctx = await context(request, 'change_role');
    return okSchema.parse(
      await service.rpc(
        ctx.caller,
        'change_member',
        { p_org: ctx.organization.id, p_user: params.user, p_role: input.role, p_remove: false },
        request.id,
      ),
    );
  });
  app.delete('/organizations/:org/members/:user', async (request) => {
    const params = validated(memberParamsSchema, request.params),
      ctx = await context(request);
    // The database allows non-owner self-leave and enforces target-role rules.
    return okSchema.parse(
      await service.rpc(
        ctx.caller,
        'change_member',
        { p_org: ctx.organization.id, p_user: params.user, p_remove: true },
        request.id,
      ),
    );
  });
  app.get('/organizations/:org/invitations', async (request) => {
    const ctx = await context(request, 'invite_member');
    return invitationsSchema.parse(
      await service.rpc(ctx.caller, 'list_invitations', { p_org: ctx.organization.id }, request.id),
    );
  });
  app.post(
    '/organizations/:org/invitations',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request) => {
      const input = validated(invitationRequestSchema, request.body),
        ctx = await context(request, input.role === 'admin' ? 'invite_admin' : 'invite_member');
      const token = randomBytes(32).toString('base64url');
      const result = z.object({ id: z.uuid() }).parse(
        await service.rpc(
          ctx.caller,
          'create_invitation',
          {
            p_org: ctx.organization.id,
            p_email: input.email,
            p_role: input.role,
            p_hash: hash(token),
          },
          request.id,
        ),
      );
      return invitationCreatedSchema.parse({ ...result, token });
    },
  );
  app.delete('/organizations/:org/invitations/:id', async (request) => {
    const params = validated(resourceParamsSchema, request.params),
      ctx = await context(request, 'invite_member');
    return okSchema.parse(
      await service.rpc(
        ctx.caller,
        'revoke_invitation',
        { p_org: ctx.organization.id, p_id: params.id },
        request.id,
      ),
    );
  });
  app.post('/invitations/accept', async (request) => {
    const input = validated(invitationAcceptSchema, request.body);
    return organizationSchema.parse(
      await service.rpc(
        requireApplication(request),
        'accept_invitation',
        { p_hash: hash(input.token) },
        request.id,
      ),
    );
  });
  app.get('/organizations/:org/notes', async (request) => {
    const ctx = await context(request);
    return notesSchema.parse(
      await service.rpc(ctx.caller, 'list_notes', { p_org: ctx.organization.id }, request.id),
    );
  });
  app.post('/organizations/:org/notes', async (request) => {
    const input = validated(noteInputSchema, request.body),
      ctx = await context(request, 'write_note');
    return noteSchema.parse(
      await service.rpc(
        ctx.caller,
        'write_note',
        { p_org: ctx.organization.id, p_title: input.title, p_body: input.body },
        request.id,
      ),
    );
  });
  app.patch('/organizations/:org/notes/:id', async (request) => {
    const params = validated(resourceParamsSchema, request.params),
      input = validated(noteInputSchema, request.body),
      ctx = await context(request, 'write_note');
    return noteSchema.parse(
      await service.rpc(
        ctx.caller,
        'write_note',
        { p_org: ctx.organization.id, p_id: params.id, p_title: input.title, p_body: input.body },
        request.id,
      ),
    );
  });
  app.delete('/organizations/:org/notes/:id', async (request) => {
    const params = validated(resourceParamsSchema, request.params),
      ctx = await context(request, 'write_note');
    return okSchema.parse(
      await service.rpc(
        ctx.caller,
        'delete_note',
        { p_org: ctx.organization.id, p_id: params.id },
        request.id,
      ),
    );
  });
}
