# LeadsFam architecture

Phase 01 implements local identity, organizations and tenant isolation. It is a modular monorepo with one React application and one Fastify API. No worker, agent execution, customer integration or hosted deployment exists.

```mermaid
sequenceDiagram
  participant Browser
  participant API as Fastify API
  participant Auth as Local Supabase Auth
  participant DB as PostgreSQL / PostgREST
  Browser->>API: Opaque HttpOnly cookie + CSRF on changes
  API->>DB: Load encrypted session under restricted runtime role
  API->>Auth: Verify user; refresh under session row lock if needed
  API->>DB: get_organization with verified user JWT
  DB-->>API: Current organization + membership role
  API->>DB: Named operation RPC with verified user JWT
  Note over DB: Recheck session, membership and permission under organization lock
  DB-->>API: Tenant-scoped result
  API-->>Browser: Validated wire contract; no provider credentials
```

The cookie is a random claim ticket. Its hash identifies a private database row; the provider credentials in that row are encrypted. The browser cannot use the ticket directly against Supabase. Supabase Auth owns password handling and JWT verification. The application owns session expiry, CSRF, enrollment and encrypted storage.

Authentication establishes identity. Authorization decides whether the identity may perform this operation in the requested organization. Isolation constrains which rows and references the operation can touch. A signed-in user still has no authority in an arbitrary workspace. The backend resolves the requested organization through current database membership into typed context, and each database operation checks again so a stale context cannot survive revocation.

Tenant operations use a named PostgREST RPC with the verified user's JWT. The direct session-store PostgreSQL login has no tenant grants. Public wrappers use invoker security; bounded private functions use a dedicated non-login role with explicit policies. The one approved Auth-email lookup has exceptional migration-administrator ownership, documented and tested in [ADR 0008](../decisions/0008-verified-email-security-review.md).

`apps/web/src/lib/api-client.ts` centralizes transport, CSRF, cancellation, credentials and runtime validation. Presentation components call typed methods. Session loading hides protected routes. The current workspace is part of the URL, and workspace components remount on a different organization ID; pending reads are aborted and late results ignored. Sign-out/recovery changes are broadcast to sibling tabs; focusing a tab revalidates its session.

Dependency direction is web → UI/shared, API → shared/database, and these packages → config for tooling. The database package is server-only and contains the PostgreSQL pool factory and generated schema types. Shared contracts contain no persistence, credentials or server imports. The worker, agents, integrations and observability packages remain deferred.

`/health` remains a public liveness check, not a claim about database security or production readiness. The API factory supports injection tests and does not listen until `server.ts` starts it. Existing body limits, safe error envelopes, request IDs, log redaction and exact CORS origins remain. Credentialed CORS is limited to `/v1/`; mutating routes require an allowed Origin and session-bound CSRF token. Production requires HTTPS origins, secure host-only cookies, explicit identity configuration and a verified runtime database role.
