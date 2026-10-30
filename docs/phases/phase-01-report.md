# LeadsFam Phase 01 engineering report

**Status: Phase 01 local implementation and all required local verification gates are complete.** No Phase 02 work, hosted infrastructure, deployment, customer import, production credentials, external production integration, commit or push occurred.

## Outcome and scope

The repository now implements real Supabase Auth, server-owned encrypted opaque sessions, separate recovery credentials, organizations, memberships, invitations, tenant-scoped notes, database authorization/RLS, and accessible frontend flows under the LeadsFam name. The approved no-argument verified-email helper is implemented with its exact narrow grant boundary and tests. Internal `@leadops` package names were preserved.

The last complete application/database run passed 58 code tests, 61 pgTAP assertions, nine multi-connection concurrency tests and 20 real Auth/API tests. All type, lint, format and production-build gates passed. Dependency audit found no known vulnerabilities. Working-tree and Git-history secret scans passed, including provider/session/database detection canaries.

Final network inspection initially found wildcard publication despite the project bridge loopback option, so work stopped for review. The user explicitly approved Docker Desktop’s “Localhost by default” setting. It was applied through the UI; no unrelated containers were running during the required engine restart. After restarting only LeadsFam, both Docker publication and macOS listeners showed `127.0.0.1` / `::1` for all four development ports. The clean reset and complete database security gate passed again. The binding check remains enforced. See [ADR 0009](../decisions/0009-local-container-binding-review.md).

## Increment results

| Increment                       | Implemented and validated                                                                                                                         | Current result                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 01A local infrastructure/schema | Docker daemon health, Supabase startup, clean reset, schema, grants/RLS, generated types and initial policy/race gates                            | Passed, including reviewed loopback correction       |
| 01B authentication              | Real signup/OTP verification/login/logout/recovery, expiry, refresh locks, encryption/key rotation, failure handling, Origin/CSRF and rate limits | Passed                                               |
| 01C organizations/authorization | Atomic owner creation, current membership context, roles, invitations, notes and repeated database authorization                                  | Passed                                               |
| 01D frontend                    | Auth/loading/error states, recovery, onboarding, URL-based workspace switcher, notes, team settings, invitation links and session propagation     | Passed automated and browser checks                  |
| 01E final verification/docs     | CI jobs, audit, secret scanning, advisors, drift, architecture/learning/security documentation and runtime inspection                             | Passed; network hold resolved with explicit approval |

## Environment and installation evidence

- Node 26.13.0 LTS and pnpm 12.16.1 remain pinned through `.nvmrc`, engines, package manager and CI. The runtime's official support verification is recorded in the Phase 00 report/ADR 0002.
- Docker Desktop 4.97.0, Engine/client 29.9.2, Linux/arm64 daemon and the local desktop-linux context were verified. Initial daemon startup was slow but recovered without reinstalling. Supabase CLI 2.122.0 is pinned and PostgreSQL 17 is selected.
- Licensing conditions were presented; the user replied “I have free docker and it is open.” Use proceeded on that confirmation. No independent check of company size/revenue or paid entitlement was performed. [Docker's terms](https://docs.docker.com/subscription-billing/desktop-license/) describe free personal/small-business use and paid-use conditions.
- The unused Supabase JS SDK 2.118.0 failed strict TypeScript 6 compilation because browser credential declarations conflict with DOM types. It was removed instead of disabling library checking. A typed, runtime-validated adapter uses the [official Auth HTTP API](https://github.com/supabase/auth/blob/master/openapi.yaml); Supabase still owns passwords and token issuance.
- PostgreSQL client `pg` 8.23.1 and `@fastify/rate-limit` 11.2.1 are exact dependencies. The frontend declares Zod 4.6.7 explicitly for API contract types. A frozen-lockfile install passed with strict peer/engine policies and no peer overrides or suppressed meaningful warnings.
- Resolved setup failures included sandbox access to CLI telemetry/preferences and the package store, PostgreSQL role/ownership restrictions during migration development, the initial verified-email RLS failure that triggered the approved ADR 0008 review, ordinary-role test lock-barrier permissions, and formatting/strict type checks. These were corrected and gates rerun. The expanded scanner initially detected its own synthetic connection-string builder; runtime URL construction removed that false positive without weakening the rule or adding an allowlist.
- The network-aware launcher initially passed `--network-id` to type generation. CLI 2.122.0 rejected it with `GenTypesNetworkIdUnsupportedError` because it now generates types in-process. The launcher omits that option only for type generation, uses the host-local database and retains the dedicated bridge for container-backed operations. The full drift/security gate then passed; no failure was suppressed.
- Docker’s old “Open (Default)” port-binding preference was changed only after explicit user approval. The UI reported one unsaved change, and no unrelated containers were running at the required engine restart. Actual IPv4/IPv6 host listeners and Docker mappings were verified after restart and after the clean database reset.

## Important architecture decisions

The browser holds a random claim ticket in an HttpOnly cookie. Its hash locates a private row containing encrypted Supabase credentials. This keeps provider tokens out of browser storage and provides immediate application revocation. It costs a database lookup, encryption/key operations, cleanup and refresh locking; the comparison against browser SDK, SSR cookies and encrypted cookies is in [ADR 0005](../decisions/0005-session-architecture.md).

Three responsibilities stay separate: **authentication** verifies who is calling; **authorization** checks what that identity may do in the requested organization; **isolation** constrains which database rows and relationships are reachable. The browser's organization ID is a request, never proof. The backend resolves current membership into typed organization context, and each operation checks again under its database lock.

Tenant RPCs carry the verified user's JWT. The runtime's PostgreSQL login can persist sessions but cannot read tenant/Auth tables or invoke tenant mutation RPCs. Most private definer functions use a restricted non-login, non-BYPASSRLS owner with explicit policies. The single approved verified-email helper runs as the migration administrator, takes no identity arguments, reads only the enrolled caller's current verified email and is executable only by the policy role. Tests inspect owner, argument count, search path and role grants.

A recovery code creates a `recovery` session, never an application enrollment. Even a genuine recovery JWT cannot access organizations through the raw Data API. Before replacing a password, a committed fence revokes application sessions and blocks concurrent enrollment. Failure leaves access blocked for a recovery retry; success requires fresh password sign-in. This favors security over availability across a provider call and a database transaction that cannot be atomic together.

The current workspace lives in the URL rather than a shared mutable global. Switching remounts workspace content, aborts reads and ignores late results. Tabs can select different organizations; sign-out propagates across tabs. The centralized typed API client owns credentials, CSRF, cancellation and response validation.

## Schema and privilege changes

| Record                     | Purpose and invariant                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `profiles`                 | Minimal display name keyed to Auth identity; visible only to the enrolled user/shared active teammates             |
| `organizations`            | UUID/name; atomic creation with initial owner and deferred owner invariant                                         |
| `organization_memberships` | Unique `(organization_id,user_id)`, owner/admin/member role, revocation retained for references                    |
| `organization_invitations` | Hashed single-use token, matching verified email, admin/member only, expiry/revocation and current issuer checks   |
| `organization_notes`       | Minimal tenant-isolation resource; immutable tenant/author and composite membership FK                             |
| `private.app_sessions`     | Hashed opaque ID, encrypted envelope, CSRF hash, purpose, provider-session FK, idle/absolute expiry and revocation |
| `private.auth_guards`      | Per-user password-recovery fence ordering enrollment with provider updates                                         |
| `private.settings`         | Production-default-disabled organization creation; enabled only by local seed                                      |
| `private.security_events`  | Append-only application grants for Auth and organization security events; no browser read grant                    |

Public tenant tables have RLS and deliberate SELECT grants. Lifecycle mutations have no ordinary direct-write grants. Public RPC wrappers use invoker security and call bounded private implementations. Organization mutations take exclusive row locks; ordered reads take shared locks and recheck membership after waiting. Ordinary operations cannot remove/change an owner or delete a workspace. The database owner invariant is independently tested using competing privileged fixture transactions.

| Operation                                                 | Owner | Admin     | Member    |
| --------------------------------------------------------- | ----- | --------- | --------- |
| Read workspace/members/notes; manage own notes            | Yes   | Yes       | Yes       |
| Rename workspace; moderate notes                          | Yes   | Yes       | No        |
| Invite/revoke member invitation                           | Yes   | Yes       | No        |
| Invite/revoke admin invitation; change member/admin roles | Yes   | No        | No        |
| Remove member                                             | Yes   | Yes       | Self only |
| Remove admin                                              | Yes   | Self only | No        |
| Remove/change owner or delete workspace                   | No    | No        | No        |

## API surface

All protected routes are under `/v1`; `/health` remains public liveness only.

- `GET /auth/session`; `POST /auth/sign-up`, `/auth/verify-email`, `/auth/resend`, `/auth/sign-in`, `/auth/sign-out`, `/auth/forgot-password`, `/auth/recovery`, `/auth/reset-password`.
- `GET/POST /organizations`; `GET/PATCH /organizations/:org`.
- `GET /organizations/:org/members`; `PATCH/DELETE .../members/:user`.
- `GET/POST /organizations/:org/invitations`; `DELETE .../invitations/:id`; `POST /invitations/accept`.
- `GET/POST /organizations/:org/notes`; `PATCH/DELETE .../notes/:id`.

Zod rejects malformed/extra input. Missing application authentication returns 401; role denial returns 403; foreign/nonexistent resources return the same 404; lifecycle conflicts return 409. Unexpected provider/database failures return safe errors without internal messages. Mutation routes require an exact allowed Origin and session-bound CSRF token. Production configuration requires public provider keys, HTTPS, verified database TLS and closed organization creation. Production cookies use `__Host-`, Secure, HttpOnly, SameSite=Lax and no Domain attribute.

Default throttling is 120 requests/IP/minute for routes without overrides. Auth-sensitive routes override to 20/route/IP/minute, organization creation to five/IP/hour, invitation creation to 20/IP/hour. These are process-local limits, not a distributed/global account-abuse solution.

## Actual verification results

| Gate                             | Actual completed result                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Passed; lockfile unchanged, strict policies retained                                                                                                                                |
| `pnpm verify`                    | Passed formatting, six-package boundaries, zero-warning ESLint, strict types, 58 tests and five build tasks                                                                         |
| Code test breakdown              | Six boundary, 23 API/config, 24 frontend, two shared-contract and three UI tests                                                                                                    |
| Clean local startup/reset        | Passed repeatedly with migrations and synthetic seed, including fresh data volumes; repeated after the approved network correction                                                  |
| `pnpm db:test`                   | 61 pgTAP assertions passed with ordinary authenticated/anonymous roles                                                                                                              |
| `pnpm test:database`             | Nine lock-barrier concurrency tests passed                                                                                                                                          |
| `pnpm test:identity`             | 20 real Auth/API assertions/tests passed, including nested cases                                                                                                                    |
| `pnpm db:advisors`               | No security/performance findings; warning/error severity blocks                                                                                                                     |
| `pnpm db:types:check`            | Passed generated public schema drift check                                                                                                                                          |
| Dependency audit                 | No known vulnerabilities; high/critical policy blocks CI                                                                                                                            |
| Secret scan                      | All three canaries passed; no leaks in working tree or one available Git commit/history                                                                                             |
| Desktop/mobile browser           | Sign-in, onboarding, note creation, switching, separate-tab selection, settings and cross-tab logout passed; 390px layout had content width 390px; Escape restored navigation focus |
| Browser errors                   | No warnings/errors in the inspected verification tab                                                                                                                                |
| Final Docker binding gate        | **Passed**: all four ports publish only on IPv4/IPv6 loopback; Docker metadata and macOS listeners agree                                                                            |
| Remote GitHub CI                 | Configured, not executed: no commit/push was authorized                                                                                                                             |

The database suite covers anonymous/foreign/revoked/expired/unenrolled/recovery identities, role escalation, immutable tenant identity, tenant-aware FKs, profile privacy, direct-write denial, atomic ownership, last-owner preservation, verified-email freshness, invite expiry/issuer authority/replay and the onboarding flag. Concurrency tests cover demotion versus queued writes, revocation versus role changes/active reads, competing owner removals, double acceptance, both accept/revoke orderings and wrong-email races.

Auth tests use real local signup/OTP/mail/verification and signed provider credentials. They also exercise CSRF/Origin rejection, cookie flags, invalid/expired/provider-revoked credentials, one refresh across five concurrent loads, lazy key rotation, ciphertext tampering, bounded cleanup, provider failure, password-update failure/retry, stale sign-in fences, rejected administrator runtime roles, and a real persistence failure after remote refresh. No partial credentials are returned on that failure. The tests use privileged connections only for explicit synthetic setup/fault injection and cleanup; ordinary tenant operations carry user JWTs or authenticated SQL roles.

CI now has a disposable Docker/Supabase security job with clean reset, binding inspection, Auth/RLS/concurrency tests, advisors and generated-type drift. All jobs fail on their required command failures. No deployment workflow was added.

## Remaining limitations and security limits

No unresolved Phase 01 local verification failures remain. The following operational limits are explicit and do not establish production readiness.

1. No hosted staging/production environment, managed encryption keys, backup restore drill, distributed throttling, production SMTP, frontend CSP/TLS deployment, monitoring/alerting, audit retention/export or incident process is implemented. Production signup abuse policy remains separate from the disabled organization-creation flag. MFA and sensitive-action reauthentication are future reviewed work.
2. Definer-function bodies and the approved administrator-owned email helper remain security-critical. Runtime-key compromise exposes server session credentials; HttpOnly does not prevent an XSS script from issuing requests. A missing encryption key revokes affected sessions; key distribution must precede activation across all workers.
3. Recovery/provider operations span systems. Failed password completion intentionally blocks enrollment until retry; refresh followed by failed persistence may require fresh sign-in. Already returned data cannot be recalled, and direct table reads follow statement-snapshot semantics.
4. Invitations use copyable links, not external delivery. Fragments avoid HTTP query/referrer logging but may appear in browser history until scrubbed. Acceptance still requires the matching current verified email. Owner transfer/deletion, customer features and deferred packages remain unimplemented.
5. Automated tests and local browser inspection are meaningful regression evidence, not a penetration test or proof of every production failure mode. Actual remote CI remains unverified until an approved push.

## Manual verification

On a new Docker Desktop installation, set “Localhost by default” before first startup as described in ADR 0009. This workstation is configured and verified. Inspect actual addresses with `pnpm db:bindings:check`; it must pass. Never disable that gate.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm db:start
pnpm db:bindings:check
pnpm db:reset
pnpm verify
pnpm verify:database
pnpm audit:dependencies
pnpm scan:secrets
pnpm dev
```

`db:reset` deletes the disposable local dataset; stop development processes before running it. No real customer data belongs in this environment. Verification/recovery mail is at `http://127.0.0.1:54324`; web is at `http://127.0.0.1:5173` and API health at `http://127.0.0.1:3001/health`.

1. Register synthetic account A (`@example.test`, password 12–128 characters), read its local Mailpit code, verify and sign in. Create workspace A and a recognizable note.
2. Create a second workspace; switch between them and confirm the note appears only in A. Open both workspace URLs in separate tabs and confirm selections remain independent.
3. Use another browser profile for synthetic account B. Opening A's URL must return an unavailable-resource view. Invite B's matching email from A, copy its link, sign in as B and explicitly accept it. Replay must fail.
4. As B/member, attempt settings/role escalation and owner removal. Controls should be restricted and API/database enforcement must still deny forged calls. Revoke B as owner; retry from B's same active session and confirm loss of access.
5. Start password recovery, enter the local code and confirm only password completion is available. Complete it yourself, sign in with the new password, and confirm old sessions/old password fail. A recovery credential alone must never display a workspace.
6. Sign out in one tab and verify another tab loses protected content. Check mobile navigation/keyboard focus, loading/error retry, empty lists and public platform status. Health success alone is not an identity/database readiness claim.

Desktop and mobile captures contain synthetic workspace data: [desktop](screenshots/phase-01-workspace-desktop.png), [mobile](screenshots/phase-01-workspace-mobile.png). The applied [Docker setting](screenshots/phase-01-docker-localhost.png) is also captured. The [learning guide](../learning/phase-01.md) explains the design in everyday terms, with the request sequence in the [architecture overview](../architecture/overview.md).
