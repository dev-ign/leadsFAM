import type { Database } from '@leadops/database';
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
    let response: Response;
    try {
      response = await fetch(`${this.store.config.url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: this.store.config.publicKey,
          authorization: `Bearer ${caller.tokens.accessToken}`,
          'content-type': 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      throw new IdentityFailure(503, 'DATA_UNAVAILABLE');
    }
    let result: unknown;
    try {
      result = (await response.json()) as unknown;
    } catch {
      throw new IdentityFailure(503, 'DATA_UNAVAILABLE');
    }
    if (!response.ok) {
      const failure = result as { message?: unknown; code?: unknown };
      if (response.status === 401 || failure.message === 'unauthenticated')
        throw new IdentityFailure(401, 'SIGN_IN_REQUIRED');
      if (failure.message === 'not_found' || failure.message === 'invitation_invalid')
        throw new IdentityFailure(404, 'NOT_FOUND');
      if (
        failure.message === 'forbidden' ||
        failure.message === 'onboarding_disabled' ||
        failure.message === 'email_unverified'
      )
        throw new IdentityFailure(403, 'FORBIDDEN');
      if (
        failure.message === 'last_owner' ||
        failure.message === 'already_member' ||
        failure.code === '23505'
      )
        throw new IdentityFailure(409, 'CONFLICT');
      if (failure.code === '23514') throw new IdentityFailure(400, 'INVALID_REQUEST');
      throw new IdentityFailure(503, 'DATA_UNAVAILABLE');
    }
    return result;
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
