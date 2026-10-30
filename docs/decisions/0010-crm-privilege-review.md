# ADR 0010: CRM privilege boundary

Status: implementation review, 2026-10-30. Written before applying CRM migrations.

The Phase 01 baseline passed `pnpm verify` and `pnpm verify:database` before this change (58 code tests, 61 pgTAP assertions, nine concurrency tests and 20 real Auth/API tests). The existing migrations remain unchanged.

## Execution and ownership

`leadsfam_crm` is a NOLOGIN, NOSUPERUSER, NOBYPASSRLS role. It owns only explicitly named private CRM functions. The migration administrator owns tables. The CRM role cannot assume the policy, session runtime, authenticated, authenticator or service roles. In particular, it does **not** inherit `authenticated`: doing so would inherit Phase 01 organization and membership RPC execution rights.

The role receives USAGE on `public` and `private`, not CREATE and not USAGE on `auth`. Schema USAGE permits name resolution; it does not grant access to every object in that schema. Explicit grants enumerate CRM relations and helpers only. There are no session-store, Auth-table, security-event, organization-write or membership-write grants. Table owners and migration administrators remain a privileged operational boundary, as in Phase 01.

One bounded bridge, `private.crm_context(org, permission)`, runs as the existing policy role. It accepts only a CRM permission from a closed list, calls the existing application-session and organization authorization machinery, takes the existing organization SHARE lock, rechecks current membership after waiting, and returns the verified actor UUID. It sets a transaction-local organization scope only after authorization. It never accepts an actor identity, accesses a new Auth table, or returns tokens or session data. Only the CRM role can execute it. The existing policy role already has the required privileges; this adds none to it.

## RLS and direct RPC

A second bounded policy-role helper returns only the current active assignment generation for a target member within an organization the caller currently belongs to. It is executable only by CRM, exposes no profile or Auth data, and avoids granting CRM direct access to Phase 01 membership tables.

Every CRM table has RLS. Browser roles receive SELECT on public CRM data only, subject to current application-session and membership checks. No browser role receives direct mutation privileges. Private receipts and import records have no browser table grants.

The CRM execution role has its own tenant policy requiring BOTH the authorized transaction organization scope AND current membership. It does not inherit another role's permissive policies. A caller-set scope alone confers no membership. Private import policies additionally require Owner/Admin authority. All joins and foreign keys carry organization identity. The database rejects cross-tenant references independently of API validation.

Public entry points are SECURITY INVOKER wrappers. Only the named wrapper and its bounded private implementation are executable by `authenticated`; default PUBLIC, anon, service and runtime execution is revoked. Private implementations use empty search paths, schema-qualified references, explicit validation and transaction-local timeouts. Direct RPC callers face the same session fence, role rules, version comparisons and lifecycle validation as HTTP callers. Internal helpers are not executable by browser roles.

## Existing privileges and invariants

Phase 01 organization, invitation, ownership, recovery and session policies remain in place. A non-definer membership trigger increments an assignment generation on active/revoked state changes; it grants no ability to mutate memberships. Existing owners remain protected by the deferred owner invariant. CRM operations use organization SHARE locks; membership mutations use UPDATE locks. An operation admitted before revocation can finish; a queued or later operation rechecks authorization and fails after revocation wins.

Negative tests must prove role attributes and inheritance, lack of CREATE and Auth/session access, lack of Phase 01 mutation-helper access, denied direct writes, tenant RLS, foreign composite references, unauthorized private helper calls, raw recovery credentials, and revoked memberships. Tests also inspect function owners, search paths and grants. Advisors and the complete Phase 01 regression suite remain acceptance gates.

No broader authority is planned. A need for BYPASSRLS, Auth/session access, service-role inheritance or unrelated private data requires separate approval before implementation.

Policy composition and owner behavior were checked against the [PostgreSQL 17 RLS documentation](https://www.postgresql.org/docs/17/ddl-rowsecurity.html). Request-constant scope evaluation follows the [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select); membership and session checks remain volatile.
