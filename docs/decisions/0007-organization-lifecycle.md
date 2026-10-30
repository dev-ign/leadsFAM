# ADR 0007: Organization lifecycle and invitation safety

Status: implemented and verified locally in Phase 01. No hosted onboarding is authorized.

Organization creation and initial owner membership commit together. Production self-service creation defaults to disabled in a private database setting as well as API configuration; an authenticated caller cannot bypass it through direct RPC. Only local development seed/bootstrap enables it. A local seed is never a staging/production migration.

Owners/admins can invite ordinary members; only owners can invite admins. No invitation grants owner. Invitations use a random single-use token whose hash is stored, are bound to the invitee's current verified Auth email, expire, and can be revoked. Raw tokens are never logged, placed in localStorage/sessionStorage, or put in HTTP query parameters. The copyable link carries the token in a URL fragment; browser history can retain it until navigation/scrubbing. Matching current verified email is required in addition to the token. Acceptance is a CSRF-protected explicit operation, never a GET side effect. The pending login preserves a restricted same-origin return path and invitation fragment in router history state. Provider credentials remain exclusively server-side. This avoids adding a second invitation-intent store. The fragment is scrubbed once the join page mounts; the token is then held in component memory for explicit acceptance.

Lock organization first and invitation second consistently. Acceptance checks the current inviter authority (including revoked membership or demotion), invitee identity/email, requested grant, expiry, revocation and single-use state after locking. Acceptance and membership upsert commit together. Two competing accepts create one effective grant; a revoked invitation cannot win a later acceptance, and an already accepted token cannot change role on replay.

Regression tests cover simultaneous acceptance by the intended user, a different user racing acceptance, revoke versus accept in both lock orderings, inviter demotion before acceptance, existing-member behavior, expiration and final-owner preservation. Security events use verified actors, organization IDs, event names, outcome and request correlation; no credentials, passwords, OTPs or raw invitation tokens.

No external production email provider is connected. Supabase verification/recovery mail uses only the local mail catcher. Invitation delivery in this phase is a copyable link; real outbound delivery remains deferred.
