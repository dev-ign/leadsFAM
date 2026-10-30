# ADR 0008: Verified-email lookup — approved narrow exception

Status: user explicitly approved the narrow helper and required tests after reviewing this proposal. The privilege exception is implemented and passed the required privilege, identity, recovery and concurrency tests in 01A.

## Finding

The initial design expected a non-login, NOBYPASSRLS function-owner role with explicit column grants to read the current user's verified email from auth.users. Actual ordinary-role tests prove that Supabase's own auth.users RLS still prevents this read. The function receives no row and organization creation fails with email_unverified. This is a failed positive-path test, not a successful Phase 01 gate.

Do not disable Auth RLS, trust user_metadata, accept a frontend email as proof, give the API broad Auth table access, or substitute a service-role client. The user reviewed and approved the narrow exception before authentication implementation.

## Proposed narrow exception

A private, non-Data-API-exposed lookup with no user-ID or email arguments would execute as the existing migration administrator (`postgres`, which has BYPASSRLS in this stack). Only the existing NOLOGIN function role could invoke it. The API's session-store role, anonymous users, authenticated browser roles and service_role would not receive execution rights.

```sql
create function private.current_verified_email() returns text
language sql volatile security definer
set search_path = ''
as $$
  select pg_catalog.lower(u.email::text)
  from auth.users u
  where u.id = auth.uid()
    and u.email_confirmed_at is not null
    and private.active_application_session()
$$;
alter function private.current_verified_email() owner to postgres;
revoke all on function private.current_verified_email()
  from public, anon, authenticated, service_role, leadsfam_runtime;
grant execute on function private.current_verified_email() to leadsfam_policy;
```

The approved implementation must remove the unnecessary direct Auth-column grants from the non-login role and make organization creation/invitation acceptance call this one helper. Keep it outside the bulk ownership-transfer loop so its exceptional ownership remains explicit. Ordinary membership and tenant queries retain their non-login, NOBYPASSRLS function owner and user-scoped database identity.

The helper may return only the currently verified caller's email. It exposes no arbitrary user lookup, token material, password hash, dynamic SQL, writable Auth access or generic database query. Its caller identity is the request's provider-verified JWT context, not the function owner's identity.

## Required tests before accepting the exception

- Inspect schema exposure, exact execution grants, function owner and empty search_path.
- Anonymous/browser/session-runtime roles cannot directly execute the helper.
- Unenrolled, recovery-only, expired and revoked sessions yield no ordinary organization authority.
- The helper returns no row for an unverified user and cannot select a different user.
- Changed email/user_metadata or stale JWT email claims cannot make the helper return an old or arbitrary verified email.
- Organization creation and intended invitation acceptance succeed; wrong-email, revoked, expired and raced acceptance fail appropriately.
- Retain current cross-tenant denial and least-privilege tests; complete the concurrency suite.

## Alternatives

Trusting only backend-verified email leaves a direct RPC bypass if the database accepts a client-provided email. Caching verified email in session records can become stale after an Auth email change. Modifying Supabase's own Auth RLS adds broader coupling to provider internals. A static, caller-bound private lookup is the recommended smaller exception, but it changes the originally proposed privilege boundary and therefore needs review.
