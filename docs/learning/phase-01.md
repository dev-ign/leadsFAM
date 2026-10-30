# How LeadsFam identity and workspaces work

Think of a shared office building. Authentication checks your ID at reception. Authorization checks whether your team has given you permission to open a particular room. Data isolation makes sure a key for one team's room cannot open another team's filing cabinet. Passing reception is not enough to access every room.

## Follow one request

1. The browser sends an opaque cookie: a random claim ticket, not a user ID or a Supabase token.
2. Fastify hashes the ticket and reads the private session row through a restricted database login. It checks expiry/revocation, decrypts the row and verifies the user with Supabase Auth. When necessary, one row lock coordinates token refresh across concurrent requests.
3. The browser asks for a workspace ID from its URL. The API treats this as a request, not proof of access. It resolves current membership through the database and builds typed organization context.
4. The named operation RPC checks session enrollment, membership and operation permission again, while holding its organization lock. RLS and database constraints further limit reachable rows and relationships.
5. Zod validates the returned data at both server and frontend boundaries. The browser receives permitted application data, never provider access/refresh tokens.

TypeScript catches mistakes while writing code; it cannot guarantee a remote response has the expected shape. Zod checks the actual values at runtime. The shared package lets both sides use one wire contract without importing server code into the browser.

## Sessions and JWTs

Supabase owns accounts, password hashing, email verification and JWT issuance. A JWT is a signed statement about identity and a provider session. Reading its JSON is not verification; the API first asks the Auth server to verify the bearer token. Roles and emails inside editable metadata are never authorization evidence.

Access tokens expire. Refresh tokens obtain replacement access tokens. Browser-managed tokens are simpler for many applications, but this product selected server-only credentials, immediate local revocation and recovery-specific database enrollment. An opaque cookie with a private session row meets those needs with one store; it adds encryption, cleanup, locks and operational responsibility. [ADR 0005](../decisions/0005-session-architecture.md) compares the alternatives and explains those costs.

The cookie is HttpOnly so ordinary JavaScript cannot read it. That helps limit token theft but does not make XSS harmless. The browser attaches cookies automatically, so every change also requires an allowed Origin and a CSRF value bound to that session. CORS controls which browser origins can read API responses; it does not authenticate a user or stop non-browser callers.

## Why recovery is a different kind of session

Someone holding an email recovery code may be trying to regain an account after compromise. Accepting that code as a normal workspace login would grant access before the recovery process is complete. LeadsFam stores it as `recovery`, and the database accepts only `application` enrollments for tenant access. A genuine recovery JWT is denied even if used directly against Supabase's Data API.

On password completion, local application sessions are revoked before the provider update. A per-user fence prevents a password login racing that update from creating a stale session afterward. If the update fails, access remains blocked and recovery can be retried. After success, the user must sign in with the new password. This is a deliberate security/availability tradeoff across two systems.

## Membership and switching workspaces

One person may belong to several organizations, and each organization may have several people. Membership connects a user to an organization and records owner, admin or member. The [permission matrix](../architecture/multi-tenancy.md) describes operations centrally. Hiding a button is presentation; the server/database still enforce permission when the request arrives.

Selecting a workspace changes the URL. Each tab has its own URL, so two tabs can work in different organizations. The old workspace component unmounts, outstanding reads abort and late responses are ignored. No browser preference or submitted organization ID creates authority. Sign-out broadcasts a session change across tabs; focusing a tab revalidates the session.

Revocation checks current membership rather than waiting for a role claim to expire. An operation already holding the organization lock can finish; revocation waits. An operation waiting behind revocation rechecks and fails. Data already downloaded cannot be erased from someone's memory or device.

## Why the database helps enforce the rules

Row-level security is a guard at the filing cabinet. An accidental unfiltered query still cannot return another team's rows. A note also has a composite foreign key tying its organization and author to a membership in that same organization; a valid user ID from a different workspace is insufficient. Triggers prevent moving an existing record's tenant identity, and a deferred owner constraint prevents an ownerless organization.

Direct table writes are denied for lifecycle changes. Narrow RPCs implement operations such as accepting an invitation, with one transaction for validation, membership creation and token consumption. Definer functions run with their owner's privileges, so their owner, search path, arguments and grants require special review. The approved verified-email helper is deliberately small and caller-bound; it is the only function retaining migration-administrator ownership.

Service-role credentials bypass RLS. Using them in every API request would remove much of the protection these tests prove. The runtime instead uses a public Supabase API key plus the verified user JWT for tenant requests. Its separate PostgreSQL login can store sessions but has no tenant-table or Auth-table read grants.

## Test the boundary yourself

Create two synthetic accounts in separate browser profiles and two workspaces. Put a recognizable note in A. Ask B to open A's workspace URL and to guess A's note ID under B's URL. Both must fail without revealing A's note. Invite B to A with its matching verified email; accept once, then try replaying the link. Revoke B and retry using the same browser session. Use recovery and confirm that tenant access stays blocked until password completion and fresh sign-in.

`pnpm db:test` proves ordinary-role grants/RLS, while `pnpm test:database` deliberately schedules competing transactions using database lock barriers. `pnpm test:identity` uses real local Auth, email codes and HTTP requests. Mock-only tests could accidentally test a fake permission system; these layers exercise the actual implementation. The report includes exact commands, outcomes, limitations and manual steps.
