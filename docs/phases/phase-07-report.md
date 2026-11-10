# Phase 07 engineering and local acceptance report

Date: November 9, 2026 (America/New_York). Risk: **Level 3**, tenant authorization, private RLS, durable ingress and communication provenance.

**Recommendation: GO for local engineering review.** A business owner can receive, review, explicitly attribute and read synthetic customer replies without automatic AI execution or outbound approval/sending. At the original local-acceptance cutoff, the implementation was uncommitted on `codex/phase-07-inbound-communications`. The subsequent authorized checkpoint review is recorded below.

## Committed prerequisite and scope

With the product owner's separate approval, the reviewed Phase 06 checkpoint was committed as `a42ef81da1c7cec5aa6e37be34d51241f309a567` on `codex/phase-06-closure` and pushed. All four jobs in [CI run 42730828855](https://github.com/dev-ign/leadsFAM/actions/runs/42730828855) passed: engineering checks, dependency audit, secret scan and database/Auth/RLS/concurrency/advisors/types. Phase 07 began only after that result, on a separate branch based on this commit. Main was not merged or rewritten. That CI result applies to the Phase 06 commit, not this uncommitted Phase 07 tree.

The product-owner Phase 07 implementation brief supplies the acceptance criteria. [The roadmap](../ROADMAP.md) retains the selected November 4 direction and the superseded November 2 alternative. No new roadmap was invented. [The architecture/contract assessment](../architecture/phase-07.md) was written before schema changes and now records the enforced security/privacy contract.

## Implemented functionality and architecture

- Verified, non-production **mock email/SMS ingress**. Bounded raw bytes and timestamped HMAC are checked before business JSON parsing; the inbound-only credential is authenticated before parsing, then current connector/authorizer authority is checked again inside the committing transaction. Browser cookies/origins and human bearer credentials cannot supply ingress authority. Invalid UTF-8, invalid text, unknown authority fields and oversized bodies are rejected safely.
- An immutable integration **capability** defaults existing credentials to `lead_intake`. New `mock_inbound` credentials cannot create leads; old intake credentials cannot receive messages. Existing expiry, rotation, pause/revoke and current administrator-generation semantics remain. A separate credential generation preserves keys across pause/resume. Inbound creation/rotation never returns a signing credential; a domain-separated derivation from the existing server-only mock root supports the local fixture tool. Existing intake one-time key behavior is preserved.
- One new private **inbound receipt table**, with organization/connector/event uniqueness, canonical fingerprint, bounded normalized content and source/time provenance. Receipt, matching outcome/message and safe audit effects commit together. Identical replay returns the same logical identity; conflicting payloads return 409. Concurrent duplicates, transaction rollback and lost acknowledgment do not create another message.
- Narrow connector creator attribution on existing messages. Incoming messages have **null human creator**, their actual connector, delivered-to-workspace state and no approval/submission metadata. Existing historical human-attributed mock rows remain readable. Original receipt time controls stable history ordering, including delayed human linking; external occurrence time remains untrusted receipt metadata.
- Existing Communications history plus a paginated **Needs Review** area. Owners can inspect a clear attribution reason, select an existing customer/compatible lead, review the intended association and confirm it. Pending operations disable conflicting controls. Keyboard focus enters the review heading and returns to the success status; its conversation link works by keyboard. Incoming/outgoing status, source, channel, arrival time and simulated labeling are visible. Long text wraps.
- Existing Integrations setup/lifecycle UI distinguishes purpose without revealing inbound signing keys. A developer-only `scripts/mock-inbound.mjs` sends synthetic local events using server configuration and prints typed receipt results only. No new inbox, queue, framework, dependency, provider or service.

### Conservative matching and resolution

A supplied reply reference must identify a submitted/delivered outbound message in the same workspace, supported channel and fixed mock-address context. Sender, active saved contact, lead and conversation relationships must agree. An unverifiable reference goes to review without fallback, including a foreign reference; it cannot reveal or select the foreign resource.

Without a reference, matching requires one active saved contact in the connector's workspace, one active lead and no competing conversation. Shared addresses, unknown customers, no lead and multiple leads/conversations produce inspectable review reasons. The same address in another workspace is unrelated. No contact/lead is automatically created, merged or updated.

Human resolution independently checks current write membership, receipt scope and compatible contact/lead ownership. Identical concurrent confirmations return one message; conflicting targets are rejected. A resolved receipt cannot be reassigned in this phase. Linking an unknown sender does not add their address to the contact, infer consent or clear suppression.

### Database/API changes

The additive migration `20261110005439_inbound_communications.sql` adds the capability/generation fields, one private receipt relation and message creator attribution. Private helpers/triggers enforce tenant scope, immutable provenance and single resolution. Existing management/read functions are extended; existing public SQL signatures and generated public types remain unchanged. Replaced function bodies preserve the prior workflow, human approval and retry/fencing logic.

New HTTP operations are limited to signed mock ingress, authorized paginated review listing and explicit human linking. Ordinary API/worker/ingress logins receive no table access. The existing NOLOGIN/NOBYPASSRLS owners retain narrowly granted operations; the communication owner can read integration ID/workspace/name columns, not credential columns. The private credential context helper is not callable by the ingress login. There are no privileged service-role application writes.

Inbound draft/edit/send/reconcile operations are rejected, inbound outbox entries are blocked by a trigger, and worker preparation defensively terminates an inconsistent inbound job. Incoming text cannot approve, send, grant consent, publish a workflow, change business knowledge or mutate canonical CRM facts. The existing six-message context selects linked inbound text only through authorized lead/contact/workspace scope. Qualification remains a separate existing human action.

## Actual automated verification

Counts below follow the existing runners, including their named nested cases. Passing unaffected cases were reused; no complete workspace suite was repeatedly executed.

| Verification                                  | Actual result                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API automation/provider boundary file         | **7/7 passed**, including strict inbound input and isolated/rotating connector derivation.                                                                                                                                                                                                                                                      |
| API transport file                            | **11/11 passed**, including production-disabled inbound and existing safe transport behavior.                                                                                                                                                                                                                                                   |
| CRM/Agents/communications/integration UI file | **31/31 passed**. After the browser identified success-focus placement, the affected review/link case alone passed again (**1 passed, 30 skipped**).                                                                                                                                                                                            |
| Communications database                       | **22 cases passed across focused/milestone runs**: five new inbound cases plus existing outbox/approval/security cases. The final milestone ran 19; three unchanged passing inbound cases were reused. Expanded cases cover no matching lead, shared sender, foreign reference, conflicting human targets and out-of-order external timestamps. |
| Communications real-Auth HTTP                 | **11 cases passed** across runs: five new inbound parent/nested cases and six existing outbound/webhook cases. Includes invalid signatures/freshness/UTF-8, pre-parse authority, size limits, CSRF, foreign access/linking, hidden signing credentials, rotation and replay.                                                                    |
| Automation database/real-Auth HTTP            | **22/22 passed**, preserving intake capability, integration lifecycle, workflow revision/delegation, replay, retries and revocation order.                                                                                                                                                                                                      |
| AI database/context/real-Auth HTTP            | **32/32 passed**, including the new actual-ingress six-message case and preserved Phase 06 durability, revocation, stale source, exact human proposal approval and mock sending.                                                                                                                                                                |
| PostgreSQL security                           | **127/127 pgTAP assertions passed**. Local advisors returned no findings; public database types match.                                                                                                                                                                                                                                          |
| Build/types/static                            | Affected API/database/shared builds/typechecks and web production build/typecheck passed. Focused ESLint, six-package boundaries, formatting and diff checks passed. Web checks were repeated only after the focus change.                                                                                                                      |
| Secret scanning                               | Existing canary plus working tree/history passed. Detection/canary now also cover inbound signing credentials; no keys or credentials were committed in Phase 07.                                                                                                                                                                               |

[Focused evidence](benchmarks/phase-07/focused-tests.json) records the initial failed fixture and correction. [Milestone evidence](benchmarks/phase-07/milestone.json) records actual stage statuses and preserved-record hashes. No failing final automated gate remains. No remote Phase 07 CI result is claimed.

### Durable execution and authorization evidence

Actual ordinary-role database tests proved one message under simultaneous identical submissions, explicit conflict for changed payload, a retry after transaction rollback, and stable replay after discarded acknowledgment. Receipt content/source and incoming messages reject mutation. One explicit human association wins under concurrency; a differing association cannot overwrite it.

Revocation-first ordering blocked pending ingress on the organization lock, then rejected it with no receipt after revocation committed. Admission-first ordering allowed the already admitted transaction to commit before revocation; later ingress failed. Expired, paused, rotated, wrong-capability and revoked-authorizer credentials were rejected. Foreign receipt reads/links and mismatched contact/lead associations failed closed. Existing exact-version approval, consent, suppression, bounded retries and uncertain-outcome behavior passed their regressions.

### Migration compatibility and preservation

The first rolled-back rehearsal caught an unparenthesized PL/pgSQL CASE expression. It was corrected before application. The successful rehearsal was rolled back; then the additive migration was applied only to the verified loopback development stack, without a reset. Existing counts/content hashes matched across **41 pre-existing public/private tables**, excluding only newly added fields on their respective tables. [Migration evidence](benchmarks/phase-07/migration.json) records the comparison.

The final database milestone also preserved existing counts/content hashes in **11 relevant organization/CRM/integration/AI/communication tables** after fixture cleanup. No historical migration was changed. A separate clean reset/replay was unnecessary for this local pass; future Phase 07 CI remains a separate gate after review/push. Preserved development volumes were retained throughout.

## Actual manual browser acceptance

Two separate synthetic owners/workspaces, FreshNest and Bluebird, were used with Michael Rivera (synthetic), one saved contact and two distinct leads. The general development worker remained stopped; controlled synthetic worker passes processed only the intended fixtures. All sending used the existing mock adapter.

| Scenario                   | Observed result                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing outbound approval | Email text was human-edited, keyboard-saved, reviewed and separately approved. SMS was separately approved. Both became mock-delivered; incoming events approved neither.                                                                                                                                                                              |
| Inbound email/replay       | Signed local tool event appeared once as Incoming email / Received with exact normalized content and connector label. Replay returned the same receipt/message IDs.                                                                                                                                                                                    |
| Inbound SMS                | Signed SMS appeared in the correct SMS conversation with simulated provenance and server receipt time.                                                                                                                                                                                                                                                 |
| Ambiguous attribution      | A message without a trusted reference and with two legitimate leads appeared as Multiple possible conversations. The owner selected the saved customer and apartment lead, reviewed the summary and confirmed. It appeared in that conversation.                                                                                                       |
| Keyboard/reflow            | Review heading received focus. A discovered success-focus gap was corrected and rechecked with an additional synthetic reply, focused test and browser keyboard navigation. At measured CSS widths **702** and **375**, document width matched viewport and long message paragraphs did not overflow.                                                  |
| Manual AI boundary         | Four unique incoming messages existed and AI count was **zero** before the intentional Analyze action. One simulated request then used exactly six context messages: four inbound and two outbound. The UI showed simulation, attributed quotes, unknowns and human review. Lead status remained NEW and the original inquiry text remained unchanged. |
| Tenant isolation           | Bluebird's user could open neither FreshNest's lead nor its conversation; both showed unavailable without customer content. Bluebird listed only its own workspace. HTTP tests separately exercised foreign mutation denial.                                                                                                                           |
| No automatic communication | Before manual analysis: four receipts/incoming messages, zero AI requests, zero pending outbound jobs. After the separate action: one simulated AI request, still zero pending outbound jobs.                                                                                                                                                          |
| Cleanup                    | The isolated accounts/workspaces/records were removed, local web/API/test processes and Supabase were stopped, and volumes preserved. No service listeners remained on the checked development ports.                                                                                                                                                  |

[Operation counts/context](benchmarks/phase-07/browser-acceptance.json), [UI observations](benchmarks/phase-07/browser-ui.json), [incoming email](benchmarks/phase-07/incoming-email.jpg), [review association](benchmarks/phase-07/manual-review.jpg), [linked reply](benchmarks/phase-07/linked-reply.jpg), [mobile history](benchmarks/phase-07/mobile-history.jpg), [simulated reanalysis](benchmarks/phase-07/manual-reanalysis.jpg), [foreign denial](benchmarks/phase-07/cross-tenant-denial.jpg).

The screenshot and browser check are limited acceptance evidence, not screen-reader certification, broad accessibility coverage, load testing or production performance. Before intentional foreign-tenant denials, captured browser warning/error logs were empty. The existing application minimum body width is 320 CSS pixels; a narrower 312-pixel probe showed an 8-pixel overflow from that pre-existing minimum, not message wrapping. Supported-width checks above passed. The existing bundle-size warning remains (517.90 kB main chunk); it was not silenced or expanded into a redesign.

## Corrections, limits and deferred work

Besides the rehearsal syntax correction, a new reconciliation fixture initially attempted its second worker pass before the existing two-second schedule. It was fixed using the existing due helper, with only the affected case rerun. Initial type checking caught ES2024-only string validation under the ES2023 target and the CRM page cursor name; validation now uses a Unicode-safe expression without changing the target, and the established cursor contract is used. A browser setup script's permission path was corrected before the walkthrough; its incomplete fixtures were cleaned. None required weakening production gates.

Deferred by the approved scope: real email/SMS providers and account routing, automatic AI analysis/replies/follow-up/orchestration, automatic lead creation/merging, contact/lead status changes, attachment/HTML parsing, semantic memory, custom cost accounting, a new queue/service/framework and an inbox redesign. Plain bounded mock text meets this foundation's objective. Receiving a signature proves the configured mock connector, not a customer's identity or truthfulness. External timestamps are retained as metadata; provider-specific trust and richer conversation timing belong to later reviewed work.

Receipt content is retained alongside its linked message and there is no purge/export/reassignment endpoint. Reviewers must consider retention/redaction and correction policy before real customer use. Mock signing root rotation requires deliberate connector credential rotation; current scope does not provide provider secret management. Production mock ingress is disabled; tests do not establish real-provider signature correctness, delivery reliability, legal policy or operational capacity.

**Phase 06 remains unaccepted for live/customer rollout**: controlled synthetic live application smoke, live-model evaluation/model selection against unchanged thresholds, privacy/retention/geography review, human usefulness assessment and approved spend controls/reconciliation remain open. Deterministic simulation still fails quality thresholds and is not live-model accuracy. No evaluator code/dataset/threshold or human approval boundary was weakened.

## External operations, data and Git status

During local implementation, the only external operational service used was GitHub to commit/push the separately approved Phase 06 checkpoint and run/read its CI. Supabase/Auth, web/API and fixture transport were local loopback services. No live AI, real email/SMS provider, new provider account, production environment or actual customer communication was used. Inputs and new workspaces/accounts were explicitly synthetic. Existing local development records were read/hashed for migration preservation; existing business records were not intentionally changed.

No dependency/lockfile or CI workflow change. Public database types are unchanged. Original local-acceptance Git snapshot: uncommitted Phase 07 changes on `codex/phase-07-inbound-communications`, HEAD `a42ef81`; nothing staged. The product owner subsequently authorized one reviewed Phase 07 commit, feature-branch push and CI checkpoint. This does not authorize production, real-provider enablement or beginning Phase 08.

## Final Git checkpoint review

The product owner authorized this checkpoint after local acceptance. Review confirmed the exact feature branch and approved Phase 06 HEAD `a42ef81da1c7cec5aa6e37be34d51241f309a567`, and reconciled all 37 files below with the working tree. All Phase 07 documentation and evidence are included; ignored documentation belongs to earlier phases. No historical migration, dependency manifest/lockfile, CI workflow, evaluator/quality threshold or generated public database type changed. The only generated artifacts included are the deliberately reviewed synthetic acceptance screenshots and JSON evidence. No environment file, credential, database dump or persisted fixture record is included.

The focused implementation review found no material security, data-loss or authorization blocker. Intake capability is the legacy default and cannot become inbound authority; both ingress functions enforce their respective capability. Incoming messages are immutable connector-authored data, rejected by outbound management and queue insertion, with a defensive worker guard. Organization-composite foreign keys, scoped RLS and current human CRM context enforce tenant/contact/lead relationships. The committing ingest function repeats connector/authorizer checks under organization/integration locks before receipt/message/audit persistence. Integration-scoped event uniqueness, canonical fingerprints and locking preserve replay/conflict/concurrency behavior. No provider, automatic AI trigger, automatic approval or automatic outbound path was added. Replaced historical function bodies were compared with their latest definitions and changed only for these Phase 07 contracts.

Valid local database, Auth, concurrency, migration-preservation and browser results above are reused because implementation code is unchanged. Final checkpoint static/security checks cover changed-file formatting/ESLint, package boundaries, Markdown local links, evidence parsing, exact file scope, whitespace and secret scanning (canary, working tree and history). Their command outcomes, the exact commit SHA and required remote CI result are reported in the checkpoint completion message; this precommit report does not claim a future CI result. Existing CI runs its database reset only in a disposable GitHub runner; the preserved development database is not reset or started for this checkpoint.

The recommendation for the next phase is **GO for separately scoped local mock-only Phase 08 work after this checkpoint's required CI passes**. Follow the selected roadmap's Conversation Orchestration objective, extend current services/workers/contracts, preserve tenant checks and explicit human approval, and keep real providers/AI acceptance gated. This assignment does not implement or start Phase 08.

## Complete changed-file list

37 files differ from the Phase 06 baseline (including this report and acceptance evidence).

- [`.gitignore`](../../.gitignore)
- [`.gitleaks.toml`](../../.gitleaks.toml)
- [`apps/api/src/app/create-app.ts`](../../apps/api/src/app/create-app.ts)
- [`apps/api/src/modules/automation/routes.ts`](../../apps/api/src/modules/automation/routes.ts)
- [`apps/api/src/modules/communications/routes.ts`](../../apps/api/src/modules/communications/routes.ts)
- [`apps/api/test/app.test.ts`](../../apps/api/test/app.test.ts)
- [`apps/api/test/automation.test.ts`](../../apps/api/test/automation.test.ts)
- [`apps/web/src/features/automation/pages.tsx`](../../apps/web/src/features/automation/pages.tsx)
- [`apps/web/src/features/communications/pages.tsx`](../../apps/web/src/features/communications/pages.tsx)
- [`apps/web/src/features/crm/crm.test.tsx`](../../apps/web/src/features/crm/crm.test.tsx)
- [`apps/web/src/lib/api-client.ts`](../../apps/web/src/lib/api-client.ts)
- [`docs/ROADMAP.md`](../../docs/ROADMAP.md)
- [`docs/architecture/phase-07.md`](../../docs/architecture/phase-07.md)
- [`docs/phases/benchmarks/phase-07/browser-acceptance.json`](../../docs/phases/benchmarks/phase-07/browser-acceptance.json)
- [`docs/phases/benchmarks/phase-07/browser-ui.json`](../../docs/phases/benchmarks/phase-07/browser-ui.json)
- [`docs/phases/benchmarks/phase-07/cross-tenant-denial.jpg`](../../docs/phases/benchmarks/phase-07/cross-tenant-denial.jpg)
- [`docs/phases/benchmarks/phase-07/focused-tests.json`](../../docs/phases/benchmarks/phase-07/focused-tests.json)
- [`docs/phases/benchmarks/phase-07/incoming-email.jpg`](../../docs/phases/benchmarks/phase-07/incoming-email.jpg)
- [`docs/phases/benchmarks/phase-07/linked-reply.jpg`](../../docs/phases/benchmarks/phase-07/linked-reply.jpg)
- [`docs/phases/benchmarks/phase-07/manual-reanalysis.jpg`](../../docs/phases/benchmarks/phase-07/manual-reanalysis.jpg)
- [`docs/phases/benchmarks/phase-07/manual-review.jpg`](../../docs/phases/benchmarks/phase-07/manual-review.jpg)
- [`docs/phases/benchmarks/phase-07/migration.json`](../../docs/phases/benchmarks/phase-07/migration.json)
- [`docs/phases/benchmarks/phase-07/milestone.json`](../../docs/phases/benchmarks/phase-07/milestone.json)
- [`docs/phases/benchmarks/phase-07/mobile-history.jpg`](../../docs/phases/benchmarks/phase-07/mobile-history.jpg)
- [`docs/phases/phase-07-manual.md`](../../docs/phases/phase-07-manual.md)
- [`docs/phases/phase-07-report.md`](../../docs/phases/phase-07-report.md)
- [`packages/database/src/automation.ts`](../../packages/database/src/automation.ts)
- [`packages/shared/src/automation.ts`](../../packages/shared/src/automation.ts)
- [`packages/shared/src/communications.ts`](../../packages/shared/src/communications.ts)
- [`scripts/mock-inbound.mjs`](../../scripts/mock-inbound.mjs)
- [`scripts/secret-scan.mjs`](../../scripts/secret-scan.mjs)
- [`supabase/migrations/20261110005439_inbound_communications.sql`](../../supabase/migrations/20261110005439_inbound_communications.sql)
- [`tests/ai/database.test.mjs`](../../tests/ai/database.test.mjs)
- [`tests/communications/database.test.mjs`](../../tests/communications/database.test.mjs)
- [`tests/communications/http.test.mjs`](../../tests/communications/http.test.mjs)
- [`tests/crm/fixture.mjs`](../../tests/crm/fixture.mjs)
- [`tests/database/fixture.mjs`](../../tests/database/fixture.mjs)
