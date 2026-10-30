# ADR 0006: Database-enforced membership and operation ordering

Status: implemented and verified locally in Phase 01.

The backend authenticates the caller, resolves the requested organization using current database membership, and constructs request-local typed context. RLS independently checks both an active application-purpose provider session enrollment and active organization membership. Browser IDs, role names, user_metadata, recovery credentials, and client-supplied actor IDs never create authority. Ordinary requests use user JWTs; the session-store database login has no tenant-table grants or tenant mutation RPC privileges.

All exposed tables start with RLS and explicitly granted operations; no automatic table exposure. Organization/member/invitation writes use narrow RPCs backed by private, reviewed functions; direct user-role table writes are denied where they could bypass lifecycle invariants. Definer functions have explicit owners/grants, an empty search_path, qualified identifiers, no arbitrary SQL or caller-supplied actor, and explicit session/identity/permission checks. Membership lookup helpers avoid recursive policies without granting public access to the membership table. SECURITY DEFINER is a deliberate exception, not a workaround for failed RLS.

Serialize organization mutations with a lock on the organization row. After acquiring it, resolve membership and permission again. Operations inside that scope either finish before revocation or observe committed revocation and fail. Reads use a shared organization lock where an explicit ordering guarantee is needed; conflicting membership changes require the exclusive lock. Do not claim that revocation can interrupt completed reads or erase data already sent to a client.

Required multi-connection tests use barriers/locks, not sleeps: hold an authorized operation and prove revocation waits; hold revocation and prove the later operation waits and then fails. Competing role changes must re-authorize after waiting, including an admin losing permission while its request is queued. Last-owner checks and immutable tenant IDs are enforced in the database. Test both API behavior and ordinary-role SQL/RPC behavior, including direct Data API calls.

Membership records are revoked rather than deleted to preserve tenant-aware references. A note's (organization_id, author_id) must reference a membership in that same organization. A user cannot move a note to another organization or create one attributed to a foreign membership. Notes are a synthetic isolation demonstration, not a lead-management feature.

The role/permission matrix is documented centrally and tested against database functions. The browser consumes capabilities for presentation only. Owner transfer and organization deletion are not exposed in this phase. Updates/removals cannot remove the final owner, and creation must establish exactly one initial owner atomically.
