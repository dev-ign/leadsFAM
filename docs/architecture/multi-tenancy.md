# Identity, permissions and tenant isolation

The current implementation is local Phase 01. Do not load customer data or treat these results as a production security certification.

| Responsibility | Question                                 | Enforcement                                                                                                                 |
| -------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Authentication | Who is calling?                          | Server-held Supabase bearer credentials verified through Auth `/user`, opaque session expiry and revocation                 |
| Authorization  | May this user do this operation here?    | Current database membership, centralized permission matrix, trusted request-local organization context and operation checks |
| Isolation      | Which rows and references are reachable? | Explicit grants, RLS, narrow RPCs, immutable organization IDs, composite foreign keys and ordinary-role tests               |

The frontend requests an organization ID; it cannot assert an authorized organization, user ID or role. `OrganizationService.authorize` resolves the caller and requested organization through `get_organization`. A subsequent operation RPC repeats authorization under a shared/read or exclusive/mutation organization lock. The current database role and membership decide access; editable `user_metadata` and stale JWT role/email values never grant tenant authority.

The session registry distinguishes anonymous, recovery and application purposes. RLS requires an unrevoked, unexpired **application** enrollment whose user and provider `session_id` match the verified JWT. Auth-only logins, email verification credentials and recovery JWTs cannot read tenant rows or create organizations through the Data API. Password completion revokes application enrollments and requires fresh password sign-in.

| Operation                             | Owner | Admin     | Member    |
| ------------------------------------- | ----- | --------- | --------- |
| Read workspace, members and notes     | Yes   | Yes       | Yes       |
| Create/edit/delete own notes          | Yes   | Yes       | Yes       |
| Moderate another user's notes         | Yes   | Yes       | No        |
| Rename workspace                      | Yes   | Yes       | No        |
| Invite/revoke member invitation       | Yes   | Yes       | No        |
| Invite/revoke admin invitation        | Yes   | No        | No        |
| Change admin/member role              | Yes   | No        | No        |
| Remove member                         | Yes   | Yes       | Self only |
| Remove admin                          | Yes   | Self only | No        |
| Remove/change owner; delete workspace | No    | No        | No        |

Non-owner users may leave their workspace. Removed memberships remain as revoked records so notes retain valid tenant-aware author references. No owner transfer or organization deletion API exists. A deferred database constraint independently prevents an ownerless organization even when privileged fixture transactions compete. Creating an organization and its initial owner is atomic. Production public creation is blocked by both API configuration and a private database setting; only the local seed enables it.

Exposed public tables have RLS and explicit SELECT grants. Lifecycle mutations have no direct user table-write grants; named RPCs enforce operation-specific rules. A note's `(organization_id, author_id)` references a membership in the same organization. Identity triggers reject organization, membership-user and note-author reassignment. Invitations store hashes, have a 72-hour expiry and require the matching current verified Auth email, current inviter authority and a single-use locked acceptance transaction.

Private elevated functions fix an empty search path, qualify identifiers and revoke default public execution. Their usual owner is NOLOGIN/NOBYPASSRLS; its explicit table policies are broad, so its bounded function bodies are an important security boundary. The approved verified-email helper alone executes as the migration administrator, accepts no identity argument and returns only the enrolled caller's current verified email. Runtime and browser roles cannot execute it directly or read Auth tables.

Revocation has an ordering rule: an authorized operation holding an organization lock may finish before revocation; an operation waiting behind revocation rechecks and fails. Already delivered data cannot be recalled. Direct Data API SELECTs use normal PostgreSQL statement snapshots; do not claim that revocation interrupts a statement already reading. Backend RPC ordering is covered by multi-connection lock-barrier tests.

Future workers and agents must derive scope from trusted job references and recheck the appropriate permission/approval state. They are not implemented. A service-role key bypasses RLS and must never become the ordinary tenant-request client.
