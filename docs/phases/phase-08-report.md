# Phase 08 engineering, acceptance and release report

Date: November 10, 2026, America/New_York. Risk: **Level 3**, tenant authorization, RLS, source freshness, durable review decisions and draft side effects.

**Recommendation: GO for consolidated business-owner manual acceptance of Phases 03–08, after the closing documentation checkpoint is remotely verified.** A business owner can receive a synthetic customer reply, explicitly evaluate it through the existing simulation worker, inspect an evidence-grounded suggested next action and prepare an unapproved follow-up without duplicate operations or autonomous communication. At the original local-acceptance cutoff Phase 08 was uncommitted; no push, merge, deployment, real-provider activation or paid AI had occurred. The separately authorized release review follows below.

## Verified baseline and scope

Started from clean Phase 07 commit `cd43b40369a13ecb42da4f579336a5bd5e11ad49`. All four jobs in [CI run 42759400196](https://github.com/dev-ign/leadsFAM/actions/runs/42759400196) were verified successful on that exact SHA. The implementation branch is `codex/phase-08-conversation-orchestration`. Those remote results belong to Phase 07. Phase 08 release evidence is recorded separately below as it becomes available.

Read the established roadmap, Phase 03–07 architecture/reports/security/context contracts, existing migrations, worker/API/UI code and smart test strategy. The product-owner brief defines this local Phase 08 scope. The [contract assessment](../architecture/phase-08.md) was recorded before schema changes. The roadmap's official phase remains **Conversation Orchestration**; subsequent phases were not renamed, implemented or started.

## Implemented lifecycle and reuse

A bounded eligibility read identifies delivered, connector-attributed incoming messages linked to an active compatible contact/lead. Unmatched receipts, outgoing messages, delivery events, historical human-attributed fixtures and replay events cannot initiate evaluation. A late human link becomes eligible only after commit. The selected reply must be present in the established recent six-message context; otherwise the owner is asked to review a more recent conversation or use existing lead analysis.

Evaluation is a separate intentional human request, **simulation-only** in this phase. It reuses the existing AI request queue, membership generations, daily/queue/concurrency limits, claims, fences, attempts, deadlines, structured qualification and server-rendered response plan. One existing draft-task execution yields qualification plus a proposal; no communication draft exists until a human prepares one. There is no second classification call, planner, workflow engine, broker or provider.

Contract v1 permits four server-mapped types: ASK_FOR_INFORMATION, PREPARE_FOLLOW_UP, HUMAN_ATTENTION and NO_ACTION. Conflict, cancellation/opt-out wording, unsupported fit, urgency, complaint and explicit qualification escalation take precedence. Generic missing information can produce ASK_FOR_INFORMATION; it is never filled in as a known answer. Existing Phase 06 escalation remains conservative, including unknown area/service, required business answers and configured restrictions. No model action name, tool, tenant, recipient or consent field selects an operation.

States are Evaluating, Pending Review, Accepted, Dismissed, Deferred, Stale and Failed. Each decision references an exact version and current authenticated CRM write authority. Deferral has no timer or automatic resumption. The existing security audit records every safe requested/evaluated/review transition; recent recommendation history shows current state, last human decision and timestamp. Earlier decisions remain in audit even after defer→dismiss or defer→accept.

## Database, API and UI changes

One additive migration, `20261110054516_conversation_orchestration.sql`, adds one private recommendation table, one delivered-context revision column on existing conversations, a bounded incoming-message index and narrow helpers/triggers under existing domain roles. Recommendations reference the existing AI result and source/evidence identifiers; entire conversations/prompts are not duplicated. Existing public SQL RPC signatures and generated public types remain unchanged.

Existing AI management/read implementations gain evaluation, exact-version review and paginated conversation history operations. HTTP adds an authorized conversation recommendation read, stable-ID evaluation PUT and explicit review POST. Strict schemas reject proposed tools, recipient/authority fields and unsupported decisions. Existing AI history adds an optional conversation review link. The ordinary AI draft-save path refuses orchestration-owned runs so lead/Agents history cannot bypass recommendation review.

The existing Communications detail gains a compact Suggested Next Action panel: simulation label, explicit Evaluate, bounded pending polling, explanation/evidence, unknowns, proposed wording, accept/dismiss/defer, confirmed draft preparation, stale/error handling and 20-row keyset history. Lead Detail links to conversation review. Existing tokens, components, scoped operations and message composer are reused. Focus enters preparation confirmation and returns to success/error status; Cancel returns to the preparation control. No new dashboard or redesign.

Explicit preparation accepts only ASK_FOR_INFORMATION/PREPARE_FOLLOW_UP, uses the saved server-rendered proposal and conversation channel, and selects the original incoming sender only when it still belongs to the saved contact. Existing permission/suppression eligibility is checked before the same Phase 04 draft operation. The stable AI run ID is the draft ID. Decision, draft identity and safe audit commit together. Replay returns the same draft without overwriting human edits. A failed preparation rolls back; it is not reported accepted/completed. Separate exact-version administrator approval and mock-only dispatch remain required.

## Security, freshness and reliable execution

The private table has scoped RLS, organization-composite foreign keys and no ordinary API, browser, worker, ingress or service-role table grants. Helpers have closed execute ACLs and empty search paths. The existing NOLOGIN/NOBYPASSRLS AI owner receives scoped conversation SELECT plus column-level row-lock grants on CRM contacts/leads. There are no service-role application writes, Auth-table shortcuts or new security-sensitive roles.

The mutation boundary rechecks enrolled session/current membership, contact/lead ownership, exact review version and current source. Existing organization/communication locks, settings locking and contact/lead share locks order review against revocation, knowledge edits and incoming/delivered context. A small delivered-message trigger increments the conversation revision under the existing coordinator lock; it performs no inference or history scan. Even a late manually linked receipt outside the six selected AI messages invalidates previous review. Pending results from changed preparation sources are stale, not actionable.

Concurrent identical source requests share one logical AI run/recommendation. Exact identical review replays preserve one outcome; conflicting decisions cannot both succeed. Rollback leaves no partial decision/draft. Lost acknowledgment can be replayed without another draft or overwritten edits. Incoming text cannot grant consent, clear suppression, approve/send, change workflow/business settings or canonical CRM facts.

Accepted/dismissed decisions remain truthful historical records when later sources change. Staleness blocks a **new recommendation action**; it does not retract a separately saved human communication. Phase 04 approval still independently requires review of the exact saved content/recipient/purpose. Worker retry, lease and uncertain-completion rules are unchanged; no new execution system was introduced.

## Actual automated verification

Used the smart-test-strategy skill: focused checks during development, one affected-domain milestone, then only the changed browser-focus case and relevant final static/web checks. Counts include runner-defined nested cases.

| Gate                                       | Actual result                                                                                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI database/lifecycle/qualification        | **35/35 passed**: 27 existing cases plus eight Phase 08 cases.                                                                                                                                                                               |
| AI real-Auth HTTP                          | **10/10 passed across focused runs**: five new parent/nested cases plus five existing.                                                                                                                                                       |
| Communications/inbound/outbound regression | **33/33 passed**, preserving Phase 07 matching/replay and Phase 04 approval/delivery.                                                                                                                                                        |
| Automation/workflow regression             | **22/22 passed**.                                                                                                                                                                                                                            |
| CRM/Auth workflow regression               | **38/38 passed**.                                                                                                                                                                                                                            |
| Core database/RLS concurrency              | **37/37 passed**.                                                                                                                                                                                                                            |
| pgTAP security                             | **127/127 assertions passed**.                                                                                                                                                                                                               |
| UI screen file                             | **32/32 passed**. After the browser focus correction, the affected case alone passed again: **1 passed, 31 skipped**.                                                                                                                        |
| Build/types/static                         | Affected API/shared/database and web production builds/typechecks passed. Focused ESLint and six-package boundaries passed. Final formatting, whitespace, documentation links/evidence and secret canary/working-tree/history checks passed. |
| Advisors/public type drift                 | No advisor findings; generated public types match.                                                                                                                                                                                           |

[Milestone results/log hashes](benchmarks/phase-08/milestone.json) and [focused results/corrections](benchmarks/phase-08/focused-tests.json) record actual runs. Security cases cover foreign reads/actions, revoked membership, ordinary-role grants, forged tool/recipient fields, CSRF, conservative mapping precedence, current consent, direct-save bypass denial, stale knowledge/context, competing decisions, concurrent evaluation/preparation and durable failure. Controlled transaction barriers proved both reply-first and review-first ordering. Late linking was tested with an unchanged six-message AI fingerprint, proving the additional revision fence matters. Rollback and discarded successful acknowledgment produced one logical draft.

### Migration preservation and corrected failures

The first snapshot mistakenly used the intentionally restricted runtime connection and failed with 42501 before schema work; verification switched to the existing verified loopback administration connection. The migration then passed a rolled-back rehearsal and was applied locally without reset. Counts/hashes matched across **42 pre-existing public/private tables**, excluding only the newly added conversation revision field. A narrow AI-history review-link function delta was separately rehearsed with rollback and applied; it changed no business rows. [Migration evidence](benchmarks/phase-08/migration.json) records the preserved data.

Initial new tests stopped in a shared fixture because its lead edit omitted the existing required version increment. That fixture was corrected. A supported fictional area was supplied rather than weakening the qualifier's unknown-area escalation; an unsupported permission field was removed. The default shell's Node 20 failed to load unchanged ESM dependencies before HTTP/UI behavior ran; all final behavioral gates used required Node **26.13.0**, without dependency changes. The browser exposed an error-focus gap after a stale action removed its button; focus now moves to the error, verified by focused UI regression and actual browser. No gate was removed or weakened.

## Actual browser acceptance

Two isolated fictional owners/workspaces, FreshNest and Bluebird, with Michael Rivera and apartment/office leads were used. General background processing remained stopped. The developer processed only the intended synthetic AI/communication claims. Initial thread setup used a separately approved mock message; the owner then exercised the new recommendation-to-draft path in the browser.

| Scenario                     | Observed result                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signed reply and eligibility | Incoming email appeared in the correct conversation. Counts before Evaluate: one receipt, zero recommendations, zero AI requests, zero pending outbound jobs.                                                                  |
| Intentional evaluation       | Existing worker produced simulated ASK_FOR_INFORMATION with attributed quotes, missing scope/timeframe and a safe proposal. No price/availability was invented.                                                                |
| Human preparation            | Confirmation received focus; Enter prepared one unapproved draft. Counts: one recommendation/run, one new draft and no send job.                                                                                               |
| Edit and separate approval   | Owner keyboard-saved exact human wording, separately reviewed/approved its saved version, and only then the controlled mock worker delivered it. Saved version was 3 after approval.                                           |
| Incoming replay              | Original receipt/message IDs were returned; recommendation, AI and draft counts remained unchanged.                                                                                                                            |
| Stale open action            | A committed correction blocked an already-open preparation with an understandable error and no draft/job. Later manual linking invalidated an already-open review too; the corrected error status received focus.              |
| Correction/escalation        | Simulation produced HUMAN_ATTENTION, with no Prepare control. Existing escalation precedence remained intact.                                                                                                                  |
| Ambiguous reply              | It stayed under Needs Review without creating AI. Owner selected the saved customer/apartment lead and explicitly linked it. A later intentional evaluation used exactly six messages, including that reply.                   |
| Human lifecycle              | Later Human Attention recommendation was deferred (nothing scheduled), then dismissed. No message was created by either decision.                                                                                              |
| Isolation                    | Bluebird listed only its own workspace and FreshNest's conversation URL showed unavailable without customer/recommendation content. HTTP tests separately denied foreign review mutations.                                     |
| Keyboard/mobile              | Confirmation and success/error focus, keyboard save/confirm and recoverable loading/errors were checked. At **390** and **702 CSS pixels**, document width matched viewport; long paragraphs wrapped. Viewport override reset. |

Final persisted counts: four incoming receipts, four intentional simulation runs/recommendations, two total outgoing messages (one setup thread and one reviewed follow-up), zero pending outbound jobs. The original lead remained NEW with unchanged inquiry text. Both synthetic accounts/workspaces were removed; twelve retained business-table hashes matched the pre-migration baseline and the recommendation fixture table was empty. Web/API and local Supabase were stopped with volumes preserved.

An intentional turn interruption terminated the fixture controller before its final evidence write. Existing screenshots, tool observations and persisted fixture outcomes were reconciled before scoped cleanup. This is documented, rather than claiming a lost raw buffer was retained. [UI observations](benchmarks/phase-08/browser-ui.json), [reconciled outcomes/preservation](benchmarks/phase-08/browser-acceptance.json), [suggested action](benchmarks/phase-08/suggested-action.jpg), [unapproved edited draft](benchmarks/phase-08/unapproved-edited-draft.jpg), [correction/escalation](benchmarks/phase-08/correction-attention.jpg), [stale denial](benchmarks/phase-08/stale-action-denied.jpg), [mobile](benchmarks/phase-08/mobile-next-actions.jpg) and [foreign denial](benchmarks/phase-08/cross-tenant-denial.jpg) preserve the evidence. Console sampling after resumption was empty; the earlier console buffer was unavailable. This is not broad accessibility, screen-reader or production certification.

## Performance, cost and limits

Twenty authenticated local Fastify-injected recommendation reads over the small synthetic history measured **p50 9.99 ms, p95 11.28 ms, maximum 25.36 ms**. They exclude TCP/TLS and external inference. Summary timings were observed before interruption; individual samples were not retained. These are limited local observations, not a production SLO, load test or causal comparison with prior CRM measurements.

Eligibility uses a dedicated incoming-message index and latest-one lookup; AI context remains the existing tenant/contact/lead-indexed latest six delivered messages with 600-character excerpts. Recommendation history uses 20-row keyset pages. Worker completion touches one indexed recommendation, with no additional model invocation. Ingress adds one bounded revision/coordinator update; its contention under production load remains unmeasured. Existing admission, queue, concurrency, attempt, input/output and deadline caps remain. Simulation records no fabricated token usage or costs.

The main web chunk retains the existing 500 kB advisory warning (approximately **519.25 kB**); it was not suppressed. The existing global 320 CSS-pixel minimum remains. The browser exercised ASK_FOR_INFORMATION and HUMAN_ATTENTION; PREPARE_FOLLOW_UP and NO_ACTION mappings are contract-tested, not live-model usefulness claims. The simulator remains intentionally incomplete and conservative. Full customer histories, richer semantic reasoning, localization and real quality remain unvalidated.

Deferred: automatic scheduling/evaluation/replies, external escalation, real email/SMS providers, paid model acceptance, arbitrary tools/planners, CRM fact updates, contact/lead creation/merge, embeddings/vector stores, frameworks, new queues/services/dependencies, large analytics/cost ledgers and UI redesign. Recommendation deletion/export, retention policy, timed resumption and comprehensive audit browsing remain future work. Deferral requires a human to return; existing audit retains earlier decisions while the UI shows bounded recent suggestions/last decisions.

## External operations and remaining acceptance gates

No real AI/email/SMS provider, production resource or actual customer communication was used. During local implementation, GitHub was read only to verify the approved baseline; official Supabase documentation was consulted. The subsequent release assignment authorizes GitHub commit, push, PR and merge operations only. Supabase/Auth, API/web and fixture transport were loopback. New business inputs were synthetic. Existing local records were read/hashed for preservation; selected retained business records matched after cleanup. Existing safe security-audit retention from test tooling remains separate from removed customer/workspace fixtures; raw audit/customer rows were not exported into reports.

Phase 06 gates remain explicitly open: controlled synthetic **live application smoke**, live-model evaluation/model selection with unchanged enforced thresholds, provider/privacy/retention/geography review, human usefulness assessment and approved spend controls/pricing/uncertain-usage reconciliation. Simulation does not pass live AI quality acceptance. Existing real inference safeguards and all communication approval boundaries remain intact.

## Final engineering review and integration target

The release brief named `master`; a fresh fetch and GitHub repository inspection instead identified default `main` at `0f92f1a9653545a91330ff2e8e99f9319aca5fbd`, with no `origin/master`. Work stopped at that gate. The product owner explicitly approved using existing `main` and its PR workflow. No new integration branch was substituted silently.

`main` contains Phase 07. Its two commits absent from the feature ancestry are the Phase 06 and Phase 07 PR merge commits; its source tree exactly matches the feature's Phase 07 baseline. No concurrent source, migration, shared-contract or CI changes require reconciliation. GitHub reports no branch protection, effective branch rules or repository rulesets. The established merge-commit PR process will preserve all history without admin bypass or branch deletion.

Independent Level 3 review reconciled every one of the 30 files against this manifest, inspected the migration and narrow replacements of existing AI functions, reviewed API/UI/test changes and synthetic screenshot evidence, and verified all nine retained milestone log hashes. No material authorization, tenant-isolation, concurrency, freshness, approval-separation or data-integrity blocker was found. Helpers remain private/scoped; inference and draft creation require human intent; exact-version communication approval remains separate. No new dependencies, infrastructure, credentials, historical migration changes or unintended generated artifacts were found. The report's superseded local-only Git wording was updated while preserving its original evidence cutoff.

Existing passing local behavioral, build, database/advisor/type-drift and preservation evidence remains applicable: only report wording changes during release review. The preserved local database will not be restarted or reset. Fresh final formatting, lint/boundary, whitespace and tree/history secret checks passed under Node 26.13.0/pnpm 12.16.1, including the detection canary and eleven reachable history commits. JSON evidence, documentation links and the empty pre-stage index were also verified. Remote CI independently ran all four unchanged jobs successfully for the exact feature and integration candidates. These remote runs use disposable CI databases, not the preserved development database. Release outcomes and exact-SHA links are recorded in the reviewed documentation follow-up below; its final remote SHA must also pass CI.

## Verified Phase 08 release checkpoint

The separately authorized release review used existing `main` after the product owner explicitly resolved the brief's `master` mismatch. No production resource, hosted database, real model/provider or external communication was used.

| Release gate                | Verified evidence                                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 07 feature baseline   | `cd43b40369a13ecb42da4f579336a5bd5e11ad49`                                                                                                                                                                                              |
| Phase 08 feature branch     | `codex/phase-08-conversation-orchestration`                                                                                                                                                                                             |
| Feature commit              | `35e7df924410a054683fb89c75f77e5836b240e1` — `feat(ai): add human-reviewed conversation orchestration (phase 08)`; exactly **30 files**, parent equals the approved Phase 07 baseline, all committed blobs match the reviewed inventory |
| Feature push and CI         | Matching remote ref verified; [run 42874204542](https://github.com/dev-ign/leadsFAM/actions/runs/42874204542), all four jobs successful on that exact feature SHA                                                                       |
| Latest main inspected       | `0f92f1a9653545a91330ff2e8e99f9319aca5fbd`, freshly fetched before candidate construction and again immediately before merge                                                                                                            |
| Upstream reconciliation     | Phase 06/07 PR merge commits retained; no concurrent source changes; source tree equals Phase 07 baseline; no conflicts or resolutions required                                                                                         |
| Combined candidate          | Isolated merge and GitHub PR candidate `9590b0c259735ffb7d5d6ce7c9d00a1f9dda8aff` had identical tree `6f438856f1aead1405ea515b7daa2a9fefddddab`, also identical to the feature tree                                                     |
| PR integration              | [PR #7](https://github.com/dev-ign/leadsFAM/pull/7), normal merge commit, no squash/rebase, force push, bypass or branch deletion; no configured branch protection/rulesets or required review gate was reported                        |
| Combined-candidate CI       | [run 42874830312](https://github.com/dev-ign/leadsFAM/actions/runs/42874830312), all four jobs successful; exact feature head and fetched PR merge parents/tree verified                                                                |
| Product integration on main | `ed0f7df9b3c44afbfe91461472632513103db517`; parents are the observed main baseline and exact Phase 08 feature commit; remote ref and ancestry verified                                                                                  |
| Product integration main CI | [run 42875350443](https://github.com/dev-ign/leadsFAM/actions/runs/42875350443), all four jobs successful on exact SHA `ed0f7df9b3c44afbfe91461472632513103db517`                                                                       |

Fresh release checks passed: repository formatting, ESLint/module boundaries, whitespace, documentation links and JSON parsing, secret-detection canary plus working tree/history scan. Independent inspection covered all thirty files, including private RLS/ACLs, composite relationships, current authority checks, six-message source boundaries, reused worker fencing, mapping precedence, exact-version decisions, freshness, consent/suppression and draft replay. No material release blocker or unrelated change was found. The only release-review edit before committing was this report's local-cutoff/authorization wording and review record.

No local behavioral suite, database startup, migration replay or reset was repeated: reviewed code was unchanged and the combined tree matched the passing feature exactly. Existing local results above were reused with verified raw-log hashes. The unchanged four-job CI workflow independently reran formatting/build/types/tests, dependency audit, tree/history secret detection and the full disposable Auth/RLS/concurrency/advisor/type-drift gate for feature, PR and main. The preserved development database and its volumes were untouched during release. The earlier 42-table migration preservation and twelve-business-table post-cleanup evidence remains unchanged.

This report-only follow-up uses the same normal PR/merge process. The product integration SHA above is the verified checkpoint **before** this documentation update; it is not misrepresented as the final documentation commit. The closing documentation PR and release handoff record the final remote main SHA and its exact-SHA CI result after that merge, along with safe local fast-forward verification. No later production readiness or live-model acceptance is implied.

Remaining limitations and all Phase 06 acceptance gates in this report stay open. The release remains human-triggered simulation with separately approved mock delivery. The next authorized product step is consolidated business-owner manual acceptance of Phases 03–08, not Phase 09 implementation or deployment.

## Git status and complete changed-file list

The original local-acceptance snapshot was uncommitted on `codex/phase-08-conversation-orchestration`, based on `cd43b40369a13ecb42da4f579336a5bd5e11ad49`, with an empty index. No manifest/lockfile, CI workflow, historical migration, public SQL signature/type or Phase 06/07 evidence was changed. The later release assignment explicitly authorizes commit, push and integration after verification. Deployment and starting the next phase remain excluded.

30 changed files relative to the Phase 07 baseline:

- [`.gitignore`](../../.gitignore)
- [`apps/api/src/modules/ai/routes.ts`](../../apps/api/src/modules/ai/routes.ts)
- [`apps/api/src/modules/organizations/service.ts`](../../apps/api/src/modules/organizations/service.ts)
- [`apps/web/src/features/ai/conversation.tsx`](../../apps/web/src/features/ai/conversation.tsx)
- [`apps/web/src/features/ai/pages.tsx`](../../apps/web/src/features/ai/pages.tsx)
- [`apps/web/src/features/communications/pages.tsx`](../../apps/web/src/features/communications/pages.tsx)
- [`apps/web/src/features/crm/crm.test.tsx`](../../apps/web/src/features/crm/crm.test.tsx)
- [`apps/web/src/lib/api-client.ts`](../../apps/web/src/lib/api-client.ts)
- [`docs/ROADMAP.md`](../../docs/ROADMAP.md)
- [`docs/architecture/phase-08.md`](../../docs/architecture/phase-08.md)
- [`docs/phases/benchmarks/phase-08/browser-acceptance.json`](../../docs/phases/benchmarks/phase-08/browser-acceptance.json)
- [`docs/phases/benchmarks/phase-08/browser-ui.json`](../../docs/phases/benchmarks/phase-08/browser-ui.json)
- [`docs/phases/benchmarks/phase-08/correction-attention.jpg`](../../docs/phases/benchmarks/phase-08/correction-attention.jpg)
- [`docs/phases/benchmarks/phase-08/cross-tenant-denial.jpg`](../../docs/phases/benchmarks/phase-08/cross-tenant-denial.jpg)
- [`docs/phases/benchmarks/phase-08/focused-tests.json`](../../docs/phases/benchmarks/phase-08/focused-tests.json)
- [`docs/phases/benchmarks/phase-08/migration.json`](../../docs/phases/benchmarks/phase-08/migration.json)
- [`docs/phases/benchmarks/phase-08/milestone.json`](../../docs/phases/benchmarks/phase-08/milestone.json)
- [`docs/phases/benchmarks/phase-08/mobile-next-actions.jpg`](../../docs/phases/benchmarks/phase-08/mobile-next-actions.jpg)
- [`docs/phases/benchmarks/phase-08/stale-action-denied.jpg`](../../docs/phases/benchmarks/phase-08/stale-action-denied.jpg)
- [`docs/phases/benchmarks/phase-08/suggested-action.jpg`](../../docs/phases/benchmarks/phase-08/suggested-action.jpg)
- [`docs/phases/benchmarks/phase-08/unapproved-edited-draft.jpg`](../../docs/phases/benchmarks/phase-08/unapproved-edited-draft.jpg)
- [`docs/phases/phase-08-manual.md`](../../docs/phases/phase-08-manual.md)
- [`docs/phases/phase-08-report.md`](../../docs/phases/phase-08-report.md)
- [`packages/database/src/rpc.ts`](../../packages/database/src/rpc.ts)
- [`packages/shared/src/ai.ts`](../../packages/shared/src/ai.ts)
- [`supabase/migrations/20261110054516_conversation_orchestration.sql`](../../supabase/migrations/20261110054516_conversation_orchestration.sql)
- [`tests/ai/database.test.mjs`](../../tests/ai/database.test.mjs)
- [`tests/ai/http.test.mjs`](../../tests/ai/http.test.mjs)
- [`tests/crm/fixture.mjs`](../../tests/crm/fixture.mjs)
- [`tests/database/fixture.mjs`](../../tests/database/fixture.mjs)
