# ADR 0011: CRM records, history and delivery identities

Status: accepted Phase 02 design, 2026-10-30.

## Contacts and history

A contact belongs to one organization and is either a person or a company. A lead always references one contact in the same organization. Up to three email and three phone entries retain display input and conservative normalized matches. Position one is primary; positions are contiguous. Matching is a suggestion, never an automatic link or merge. Missing contact channels are allowed.

Lead views join the current authorized contact. Editing a shared contact therefore updates the current information shown for every referencing lead. Lead records do not copy mutable contact names, email or phone. Activities record actor IDs, changed field names, enums and record IDs, not historical copies of contact PII. Immutable attribution records describe intake facts and are never rewritten by a later contact edit. A contact's first touch is derived from its earliest accepted lead, including archived leads.

Lead lifecycle: `new`, `in_progress`, `qualified`, `closed`. New can enter any other state; in-progress can qualify or close; qualified can return to in-progress or close. Closing requires `won`, `lost` or `unqualified`. Reopening is Owner/Admin only, requires a reason, returns to in-progress and clears current close fields. Ordinary closed-lead edits require reopening. Archiving is separate. Versions reject lost updates. Assignment stores the historical member ID and generation; an eligible current assignee additionally requires an active membership with matching generation. Rejoining never resurrects an old assignment.

All mutations lock organization, then contact, then lead, then receipt/import records in deterministic order within each class. Import execution serializes its job before individual row work and must not acquire a second organization. Every accepted business change and its activity commit together. No application hard deletion or automatic merge is exposed.

## Three import identities

Reopening rationale is retained in a separate bounded activity `reason` column, only for a closed-to-in-progress transition. This intentional human-entered business content is rendered as text and never logged. It does not contain automatically copied contact details. Explicit phone-region hints are retained so unrelated contact edits preserve conservative normalization.

These semantics are specified before implementing execution. An import **job UUID** identifies a human-reviewed batch within an organization. An **attempt UUID** identifies one immutable submission of at most 100 logical deliveries for that job. A **delivery UUID** identifies one logical source row for the lifetime of the job, regardless of corrections. Row numbers are display metadata, not deduplication keys. All three IDs are organization scoped; another job cannot claim a prior job's delivery.

The database fingerprints a canonical, schema-versioned JSON request. The caller cannot supply a trusted hash. The same attempt ID and same canonical payload returns the stored attempt result, including its original safe failures. Reusing an attempt ID with different content returns an idempotency conflict. A correction uses a NEW attempt ID and retains the delivery IDs for corrected failed rows.

The first successful result for a delivery is permanent. Subsequent attempts containing that delivery return its original record IDs when the canonical row content agrees. Changed content for an already successful delivery yields `delivery_already_succeeded`; it never creates another contact or lead. Corrected unsuccessful deliveries may succeed under a new attempt. Duplicate delivery IDs within one attempt are rejected before execution. Explicitly choosing a new delivery ID means a new logical row; clients retain the server-returned job/delivery manifest and do not regenerate identities on network retries.

Job locking serializes competing attempts. Each valid row runs in a database subtransaction: domain/validation failures become bounded error codes without raw payloads; successful rows and their immutable delivery receipts commit. Unexpected infrastructure failures roll back the entire attempt, so no half-written attempt can later be mistaken for a completed result. Response loss after commit is recovered by identical attempt replay or authorized job-result retrieval, including after API restart. No raw CSV or row PII is persisted in receipt/error records; only fingerprints, bounded codes and resulting record IDs are retained. Success receipts have no expiry that could recreate a row. Authorization is rechecked before any replay result is returned.

Executable contract tests must cover identical replay, changed attempt payload, corrected retry, unchanged successful rows, changed successful rows, duplicate delivery IDs, cross-job and cross-tenant references, competing attempts and commit-before-response loss. They must run before adding the import execution path, then the database and HTTP implementations must pass the same scenarios.

The delivery ledger claims unsuccessful deliveries too. Its organization/delivery identity, job, original row number and creation time are immutable. It may transition once from pending to success; success fingerprint and result IDs then become immutable. Each attempt stores its own immutable safe result, so replay of an earlier failed attempt still reports that earlier failure after a later correction succeeds. Owner/Admin execution has column-level UPDATE permission only for finalizing pending delivery results and obtaining the job lock; triggers reject identity changes and successful-delivery rewrites.
