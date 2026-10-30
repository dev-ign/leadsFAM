import { UserDatabase, DatabaseRpcFailure, type Database } from '@leadops/database';
import { organizationSchema, type Permission, can } from '@leadops/shared';
import type { SessionStore } from '../identity/sessions.js';
import { IdentityFailure } from '../identity/failure.js';
import type { requireApplication } from '../identity/routes.js';

type Functions = Database['public']['Functions'];
type Caller = ReturnType<typeof requireApplication>;
export interface OrganizationContext {
  organization: ReturnType<typeof organizationSchema.parse>;
  caller: Caller;
}
export class OrganizationService {
  constructor(private readonly store: SessionStore) {}
  async rpc<N extends keyof Functions>(
    caller: Caller,
    name: N,
    args: Functions[N]['Args'],
    requestId: string,
  ): Promise<unknown> {
    try {
      return await new UserDatabase(this.store.config).rpc(
        caller.tokens.accessToken,
        name,
        args,
        requestId,
      );
    } catch (error) {
      if (!(error instanceof DatabaseRpcFailure)) throw error;
      if (error.status === 401 || error.reason === 'unauthenticated')
        throw new IdentityFailure(401, 'SIGN_IN_REQUIRED');
      if (['not_found', 'invitation_invalid'].includes(error.reason))
        throw new IdentityFailure(404, 'NOT_FOUND');
      if (['forbidden', 'onboarding_disabled', 'email_unverified'].includes(error.reason))
        throw new IdentityFailure(403, 'FORBIDDEN');
      if (['last_owner', 'already_member'].includes(error.reason) || error.sqlCode === '23505')
        throw new IdentityFailure(409, 'CONFLICT');
      if (
        [
          'version_conflict',
          'idempotency_conflict',
          'duplicate_review_required',
          'archived_record',
          'closed_record',
          'invalid_transition',
          'contact_has_open_leads',
          'archived_contact',
          'delivery_job_conflict',
          'source_limit',
        ].includes(error.reason)
      )
        throw new IdentityFailure(409, error.reason.toUpperCase());
      if (error.reason === 'invalid_manifest') throw new IdentityFailure(422, 'INVALID_MANIFEST');
      if (['22023', '22P02', '23502', '23503'].includes(error.sqlCode))
        throw new IdentityFailure(422, 'INVALID_FIELDS');
      if (error.sqlCode === '23514') throw new IdentityFailure(400, 'INVALID_REQUEST');
      throw new IdentityFailure(503, 'DATA_UNAVAILABLE');
    }
  }

  async authorize(
    caller: Caller,
    requestedOrg: string,
    permission: Permission,
    requestId: string,
  ): Promise<OrganizationContext> {
    const organization = organizationSchema.parse(
      await this.rpc(caller, 'get_organization', { p_org: requestedOrg }, requestId),
    );
    if (!can(organization.role, permission)) throw new IdentityFailure(403, 'FORBIDDEN');
    // This context comes from the database. Every subsequent RPC checks again
    // under its operation lock, so concurrent revocation cannot reuse this role.
    return { organization, caller };
  }
}
