# ADR 0012: Pagination integrity and temporary drafts

Status: approved Phase 02 refinement, implementation design, 2026-10-30.

## Pagination

List requests have an explicit tenant, bounded filters, search up to 100 characters and a page size from 1 to 100 (default 25). Keyset order uses timestamp plus UUID, descending, with both values retained at database precision. A cursor is an opaque client token containing only bounded routing/position metadata and an HMAC, never raw search terms or contact data. It is bound to the verified user, organization, entity kind, full normalized query including page size, and ordering. A keyed query digest prevents exposing a dictionary-testable plain hash of search terms. Cursor lifetime is 30 minutes. A dedicated 32-byte server key is separate from session encryption keys; replacing it invalidates outstanding cursors without touching sessions.

The API authorizes the organization before verifying or returning cursor results. The database authorizes again under its organization lock and validates all limits and query fields, including direct RPC calls. The cursor is a navigation integrity control, not an authorization credential. Queries use parameters and tenant predicates; query values, search strings and token bodies are excluded from logs. Invalid signatures, malformed positions, changed filters, another organization/user and expired cursors are rejected. Revoked membership is rejected even with a valid cursor.

Keyset pagination is not a frozen snapshot. A changed activity timestamp or filter membership can move a record between pages. Refresh starts a new traversal; no cross-request snapshot guarantee is claimed.

## Drafts

Sensitive drafts exist only in memory above the route/session gate. Keys contain the last verified user ID, authorized organization ID and form identity. Focus or cross-tab revalidation hides protected content while verification runs. Successful revalidation as the same user in the same organization restores the draft and its original version. Logout, account change and membership loss discard the affected drafts; switching organizations discards the previous organization's drafts. An unavailable verification service leaves retained drafts inaccessible until the identity and organization are verified again.

No contact draft or CSV payload is written to localStorage, sessionStorage, a URL, BroadcastChannel or a telemetry event. Broadcast messages carry only session-change notifications. Navigation uses the supported React Router data router and blocker; browser refresh/close uses `beforeunload`. Sign-out has the same explicit unsaved-change decision before its side effect. Browser warnings are best effort; a refresh loses an in-memory draft.

Create forms retain their idempotency key and submitted payload across uncertain network outcomes. An uncertain submission is retried unchanged before editing or starting another logical creation. Versioned edits retain their original version so a revalidation cannot silently overwrite somebody else's committed changes. Query state keys include user, organization and the complete query; cancelled or late responses cannot populate a different scope.
