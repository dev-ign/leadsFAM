# Phase 07 — Inbound communications

## Baseline and contract assessment before schema changes

Baseline: Phase 06 commit `a42ef81da1c7cec5aa6e37be34d51241f309a567`, pushed on `codex/phase-06-closure`. All four jobs in [remote CI run 42730828855](https://github.com/dev-ign/leadsFAM/actions/runs/42730828855) passed. Phase 07 branch: `codex/phase-07-inbound-communications`; no merge or deployment.

Reuse the modular monolith, enrolled human sessions/CSRF, private domain roles/RLS, integration lifecycle, raw-byte mock signature verifier, normalized saved contact identities, conversations/messages, paginated history and six-message AI context. Use a synchronous PostgreSQL transaction, not a queue. Existing outbound drafts, human approval, consent and mock delivery remain authoritative.

The existing structures are insufficient in three specific ways:

- Integration credentials currently authorize only lead intake. Add an immutable capability defaulting existing rows to `lead_intake`; `mock_inbound` is a separate purpose. Both ingress paths must check it. Preserve pause/revoke/expiry/current-authorizer and rotation behavior.
- Intake receipts require a created lead, and delivery events require an existing outbound message. Neither can retain an unmatched customer reply. Add one private inbound receipt relation with immutable event identity, normalized content/fingerprint and connector provenance; link it once to a message automatically or through authorized human review. Use existing security audit and message events, not another audit subsystem.
- Messages support inbound direction but require a human creator. Add nullable connector creator attribution using the existing exactly-one-principal pattern. Preserve historical human-attributed synthetic rows; all newly ingested inbound messages identify their connector. No inbound message can enter outbound editing/approval/jobs.

## Implemented operating contract

Incoming events are plain email/SMS text, bounded to the current message limits and a 16 KiB transport ceiling. Normalize sender addresses and CRLF/CR to LF; preserve remaining content exactly. An optional external occurrence timestamp is metadata only. Server receipt time and UUID provide stable history order, including delayed manual links and out-of-order deliveries.

Reuse the server-only mock root secret to derive domain-separated per-integration signing credentials. Track the credential generation separately from the integration's optimistic version so pause/resume does not rotate keys. Inbound create/rotate responses and UI never disclose a signing credential. The server-only local fixture tool can derive it from existing local configuration. Existing lead-intake one-time credential behavior is unchanged.

The non-production ingress verifies bounded raw bytes, signature and freshness, and authenticates the inbound-only credential before parsing business JSON. The committing transaction independently rechecks current integration authority while holding the existing organization/revocation and integration locks. Organization is resolved from that connector, never supplied in the payload. No privileged service-role path or browser-session authority.

Event identity is unique per organization/integration/event ID. A canonical normalized fingerprint distinguishes identical replay from conflict. A response follows commit; retries after response loss return the same receipt/message. Matching never grants consent or runs AI/workflows/outbound actions.

Prefer a known outbound reply reference only when organization, mock channel/address context, saved sender, contact, lead and conversation agree. Otherwise use an unambiguous saved sender within the organization and only one compatible lead/conversation. Unknown/ambiguous/unverifiable relationships remain in Needs Review. Foreign references receive the same safe unverifiable treatment and cannot select a foreign row. Human linking independently checks current write membership and compatible existing contact/lead; competing identical links replay, differing links conflict. No automatic create/merge or later reassignment.

Reuse Communications history and Integrations setup/lifecycle screens, with a small paginated Needs Review area, explicit association confirmation and synthetic provenance. Newly linked messages use the existing delivered-to-workspace representation and authorized AI context query. Qualification remains a separate human action; customer corrections remain attributed statements.

## Security and acceptance boundaries

New relations use tenant composite FKs, scoped RLS and narrow private functions under existing NOLOGIN/NOBYPASSRLS domain roles. Ordinary logins receive no table privileges. Immutable receipt/content provenance and one-time resolution are enforced in the database. Mock ingress remains disabled in production; no real providers, autonomous approval or model calls are introduced.

Focused verification covered signature/raw-byte limits, capability separation, revocation ordering, tenant isolation, replay/conflict/concurrency/transaction failure, conservative matching, manual linking, historical data/privilege preservation, outbound regression and bounded AI context. The requested two-workspace synthetic browser walkthrough also passed. [Actual evidence and limitations](../phases/phase-07-report.md) are recorded separately; the initial contract assessment above preceded schema changes.

### Enforced security and privacy details

`leadsfam_automation` owns the capability/credential lookup and current-authorizer checks. Its private context helper returns only connector/workspace identity to `leadsfam_communications`; ingress logins cannot execute it directly or read credential hashes. An authorize-only function returns void before payload parsing. The ingest function calls the context helper again within the committing transaction. Organization SHARE locking orders admission against revocation, and the integration row serializes quota and event identity checks. Both revocation-first and admission-first orderings were tested.

`leadsfam_communications` receives scoped SELECT on integration ID/workspace/name columns, not credential columns. New receipts use scoped RLS; ordinary/API/ingress/worker logins retain no table privileges. Private linking/read helpers and triggers are closed to ordinary callers. Human resolution enters through the existing authenticated communication RPC and current CRM write context. Public SQL signatures and generated public database types are unchanged.

Receipt identity, normalized content, fingerprint and original connector are immutable. A receipt transitions from Needs Review to Linked once; conflicting later targets are rejected. Newly received connector messages are immutable, have a null human creator and cannot acquire approval metadata. Existing historical human-attributed mock rows remain readable. Outbound management explicitly rejects inbound messages, a job trigger prevents inbound queue entries, and preparation defensively terminates an inbound job without sending if privileged historical data were inconsistent.

The supplied reply reference must identify a submitted/delivered outbound message in the same workspace, channel and fixed mock-address context, with a matching saved sender and consistent contact/lead/conversation. An unverifiable supplied reference goes to review without fallback; this prevents a foreign reference from selecting another resource. Without a reference, automatic matching requires one saved contact, one active lead and no competing conversation. Human confirmation can associate a previously unknown sender with an existing compatible contact/lead, without adding that address to the contact or granting consent.

Limits reuse existing contracts: 16 KiB transport/normalized payload, 160-character safe event reference, email body up to 4,000 characters, SMS up to 1,600, 60 admissions/integration/minute, 25 integrations/workspace, 25 review rows/page, existing 50-message history pages and six-message AI context. Parser errors reject malformed UTF-8, NUL/lone-surrogate text and unexpected authority fields. Server receipt time controls message order; external timestamps remain untrusted receipt metadata and do not replace audit/context time.

The existing mock root derives per-connector/per-generation signing credentials using a versioned HMAC domain. The root and derived credential never appear in inbound create/rotate responses or UI. Rotation uses the next optimistic version as credential generation; pause/resume leave it unchanged. The local synthetic tool derives the same credential without persisting it. Existing lead-intake one-time key behavior remains unchanged, and its keys cannot authorize inbound. Secret scanning/canary now covers both credential prefixes.

One bounded content copy remains in the immutable receipt and another in a linked message so the existing history/context contract can be reused. No raw headers, signatures, raw provider payload or customer content is copied into security audit/logs. Receipts reference safe lifecycle IDs in existing audit/events. There is no purge, reassignment, retention or real-provider account-routing implementation; these require future review before customer use. A signature authenticates the configured mock connector, not a customer's identity or honesty.

Phase 06 live evaluation, controlled live application smoke, privacy review, human usefulness and spend controls remain outstanding. The product owner subsequently authorized the final Phase 07 commit/push and CI checkpoint; production, real providers and starting Phase 08 remain outside that authorization.
