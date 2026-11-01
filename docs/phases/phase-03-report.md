# Phase 03 engineering report

Status: implemented and verified locally, including the approved clean-reset and populated Phase 02F→03 upgrade paths. Ready for review and a separately authorized commit. This is not a completed production-readiness certification. Work is uncommitted on `codex/phase-03-ingestion-automation`.

## Implementation summary

Implemented the synthetic source → authenticated intake → CRM → transactional outbox → durable worker → version-bound workflow → authorized internal activity → audit/history vertical slice. The guided builder is the default product experience, with optional filters and review before activation. Saving a draft is optional. Integration controls cover one-time credentials, rotation, pause/resume and confirmed irreversible revocation. Delivery errors, queue/run states and an audited administrator retry path are visible.

There are no real model calls, provider SDKs, customer connections, outgoing messages, paid services, deployments, commits or pushes. Mirembe Cleaning remains the future first-party use case; only neutral synthetic inquiry/waitlist/booking contracts were used.

## Baseline and architecture decisions

Refreshed remote Git metadata, confirmed Phase 02F `dae5a6b` is an ancestor of `origin/main`, and branched from clean `0ec8797`, the merge of PR #1. All four checks on the [merge CI run](https://github.com/dev-ign/leadsFAM/actions/runs/41143784290) succeeded. Those results belong to the baseline, not these unpushed changes.

The merge deleted the earlier architecture/ADR/report files and ignored all documentation. Mandatory prior reports/ADRs were read from `5f52747`, including the CRM privilege boundary and future-agent boundary. `.gitignore` now permits only this phase's documentation and benchmark artifacts; unrelated historical files were not restored.

One PostgreSQL engine and immutable schema-versioned definitions serve both the guided editor and future visual editor. The engine currently accepts `lead.created`, bounded source/status conditions and internal activities. Unsupported future/advanced configuration is preserved and refused by the guided editor. No graph editor, arbitrary expression runtime, broker, microservice fleet or generic agent framework was added. See the [pre-migration architecture/security review](../architecture/phase-03.md).

## Security

Existing human sessions, CSRF, recovery fences, organization authorization and CRM execution policies remain in use. Separate restricted intake and worker LOGIN roles have no direct table access, role memberships, Auth/session access, service-role authority or BYPASSRLS. Their bounded private entry functions use a NOLOGIN/NOBYPASSRLS owner with explicit grants. Private tenant ledgers and CRM rows have RLS; composite foreign keys preserve organization boundaries. Queue-wide integration lookup/claim policies are limited to the non-login execution owner.

Credentials are random 256-bit bearer values, hashed with SHA-256, revealed once and valid for 90 days. Normal reads exclude hashes/secrets. Rotation immediately replaces the old hash; revoked credentials cannot replay old receipts. Browser Origin/cookie ingestion is denied. The endpoint rejects extra authority fields, limits bodies to 16 KiB, normalizes canonical CRM channels, bounds metadata, applies IP and durable per-integration intake limits, and uses bounded database deadlines.

Queued execution rechecks publisher role/membership generation and integration/workflow state under organization/resource locks. It never fabricates a human JWT or trusts proposed model identity. Only the registered internal activity action is executable. Human management is Owner/Admin only. No new Auth table privileges or direct tenant grants were added to the session runtime.

Focused testing found and corrected missing row-lock privileges without granting general updates, and a deferred channel-constraint issue without granting the intake login table access. IDs remain immutable. A retry-path SQL variable ambiguity and SQL step-ID typing were also corrected. Ordinary-role negative and failure tests support these findings; this is not an independent security certification.

## Reliability

The first persisted delivery attempt binds the integration/event identity and versioned canonical fingerprint. Identical replay returns the original contact/lead/receipt IDs; changed content conflicts, including after a failed business attempt. Failed attempts retain safe references/codes, not raw input. A new reviewed inquiry can use an existing contact and creates a distinct lead. Potential matches never auto-merge.

CRM changes, successful receipt/attempt and required outbox/dispatch intent are atomic. No active workflow means the event is completed without an unnecessary dispatch job. Events snapshot eligible published revisions, so later edits cannot change in-flight actions. The worker uses `SKIP LOCKED`, due timestamps, 30-second leases, random tokens, monotonic generations, bounded retries/jitter and five-attempt limits. A final fence rolls back an expired late effect. Internal activity, tool audit and completion share a transaction with a unique run/step identity. This controls logical effects under at-least-once delivery; it does not claim distributed exactly-once execution.

Tests cover concurrent duplicate intake, competing workers, real process death/restart, expired and late leases, outbox transaction failure, temporary handler failure, revision binding, typed conditions, publisher/integration revocation, ordered lock waits, operator retry and exhausted final claims. The new runtime has bounded pools/concurrency/polling and graceful SIGINT/SIGTERM behavior. Temporary test worker/API processes were stopped without stopping the user's existing servers.

## Performance

[CRM raw samples and plans](benchmarks/phase-03/results.json) use the existing Phase 02F harness, synthetic 1k/10k/50k tenants, real Auth/JWT management, four concurrent callers and 12 measured samples per read. All measured read p95 values stayed below the local 300 ms target. At 50k: list 66.2 ms, activity order 68.9 ms, contact prefix 18.0 ms, lead prefix 102.1 ms, broad contains 165.9 ms, combined filter 118.9 ms, detail 85.4 ms and timeline 62.5 ms. Sequential 100-row imports reached 791.7 ms; a four-job burst reached 2,395.6 ms, within the existing three-second local target. Query policies/indexes from Phase 02F were preserved. This is not a controlled causal comparison or a production p99/SLO claim; local browser/build activity and small samples add noise.

The [automation measurement](benchmarks/phase-03-automation/results.json) recorded 40 synthetic deliveries and 80 dispatch/action executions. Intake p95 was 4.67 ms sequentially and 10.96 ms at concurrency four; SQL job execution p95 was 7.70 ms. Forty logical activities resulted. Fastify injection excludes client TCP/TLS; job timing excludes queue/poll/claim time. A separate real loopback HTTP/browser flow took about 36.9 ms for initial intake and displayed completion about two seconds later.

The frontend keeps automation pages lazy-loaded. The production build passed, with an initial JS chunk of approximately 505 kB (154 kB gzip), slightly above Vite's 500 kB advisory threshold. That warning was not suppressed or the threshold raised. Further bundle splitting remains an optimization opportunity; browser timing and production network budgets have not been established.

## Verification record

Risk: Level 4 cross-cutting milestone, including Level 3 credentials, RLS, transactionality and durable work. Focused checks were used during implementation; broader existing regressions ran once at the milestone. Passing unaffected checks were reused after narrow fixes/copy/docs changes.

| Executed check                                                               | Actual result                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial `migration up --local` from Phase 02F through the loopback wrapper   | Applied successfully; subsequent changes were applied as non-destructive local iteration DDL/functions                                                                           |
| Phase 03 database tests                                                      | Sixteen distinct scenarios verified across the focused runs; a failing retry scenario was corrected and rerun, and final direct-tool/final-attempt/process checks ran separately |
| Phase 03 real Auth HTTP tests                                                | Passed intake/authentication, strict inputs, body/content-type limits, normalization, publication/CAS, replay/conflict, activity, tenant, rotation and revocation checks         |
| `pnpm db:test`                                                               | 127 SQL/RLS assertions passed                                                                                                                                                    |
| `pnpm test:database`                                                         | 37 existing database/race test nodes passed                                                                                                                                      |
| `pnpm test:identity`                                                         | 20 real Auth/session/recovery tests passed                                                                                                                                       |
| `pnpm test:crm`                                                              | 38 existing CRM/specification/HTTP test nodes passed                                                                                                                             |
| `pnpm db:advisors`                                                           | No findings                                                                                                                                                                      |
| `pnpm db:types:check`                                                        | No public contract drift                                                                                                                                                         |
| `pnpm test`                                                                  | 100 code/boundary tests passed before the final direct-activation refinement                                                                                                     |
| Focused CRM/automation component file after direct activation                | 18 tests passed, including review focus and exact saved-version publication                                                                                                      |
| Lint/type/build gates                                                        | Passed at the milestone; final formatting/static checks cover subsequent UI, test and documentation edits                                                                        |
| Dependency audit                                                             | No known vulnerabilities reported; dependency versions/lockfile unchanged                                                                                                        |
| Secret scanning                                                              | Working tree and four-commit history passed; provider/session/database/integration-key canaries detected                                                                         |
| CRM and automation benchmarks                                                | Passed correctness checks and recorded the local figures above                                                                                                                   |
| Remote Phase 03 CI                                                           | Not run; changes have not been pushed                                                                                                                                            |
| Final clean reset and reapplication of the packaged migration from Phase 02F | **Passed after explicit user authorization and local/disposable-data safeguards; see the final verification record below**                                                       |

The initial reset rejection was respected. The user subsequently explicitly authorized local database recreation with safeguards. Both final migration paths are now complete, as documented below. No hosted project was accessed and no check was bypassed.

## UI and manual verification

A real browser used a disposable synthetic workspace. Verified guided defaults, collapsed optional filters, review focus, direct activation, one-time credential display, confirmed revocation with Cancel focus, Escape/return focus, received-lead and conflict visibility, completed run/history and the resulting CRM activity. All inspected form fields had labels. The integration page had no horizontal overflow at 375 CSS pixels; desktop/mobile and light/dark layouts rendered. No browser warning/error logs were captured for this flow. Theme and viewport settings were restored. Scoped fixture cleanup then confirmed zero users, organizations, leads and automation jobs in the local database; only the original API/web listeners remained. This is focused accessibility verification, not a full screen-reader/WCAG audit.

The real HTTP flow accepted an inquiry, replayed its stable IDs and rejected changed content with 409. The running worker produced exactly one activity, visible in both execution history and the lead timeline. A screenshot is retained in the chat's local visualization artifacts without credentials. See the [manual](phase-03-manual.md) and [learning guide](../learning/phase-03.md).

## External dependencies and unresolved limits

No new package, provider account or infrastructure is required locally. Production still needs separately reviewed provisioning of the least-privilege logins, verified TLS and managed keys, distributed ingress controls, monitoring/backpressure/capacity, retention/deletion/export, backups/restore and incident procedures. The current queue is bounded in per-operation size, workflow fanout and worker concurrency, but has no production global admission/backlog budget. Attempts/events/receipts are retained indefinitely for correctness.

Email/SMS adapters are disabled/mocks. Persistent provider credentials, consent evidence, outbound intent and uncertain delivery reconciliation must be designed and verified before real sending. No current contact data implies communication consent. The advanced visual editor, branches/delays, additional business tools and model integration remain deferred.

The guided editor supports a narrower subset of the engine and explicitly refuses larger/unknown definitions. Management creation uncertainty requires reconciling the list, and a lost key requires replacement. Histories show bounded recent results rather than complete paginated retention administration. The initial browser test used a separate temporary port-3002 API for real HTTP ingress. During the approved reset verification the original development API was paused, then restored using the current launcher and its intake environment configuration; the existing Vite server remained running.

## Git status and Phase 04 readiness

Branch: `codex/phase-03-ingestion-automation`, based on `0ec8797`. Changed areas are one additive migration, restricted database/API/worker modules, shared contracts, the existing API client/routes/CRM views plus guided UI, fixture cleanup and focused tests, scanner integration-key detection, startup/scripts, and this phase's documentation/performance evidence. No commit, staging, push, merge, deployment or hosted mutation occurred. The prior four green CI checks apply only to `main`.

The local Phase 03 acceptance gates are satisfied, including packaged clean-reset and upgrade verification. The changes are ready for code review and a separately authorized commit, and the foundation is suitable for continued local Phase 04 design after review. It is not yet approved for connecting a real business, enabling providers or running autonomous models. Completing a local reset check alone would not remove the production/communications requirements above.

## Approved final migration verification

Completed 2026-10-30, America/New_York. Scope was only the existing `lead_gen` development stack: API `127.0.0.1:54321`, PostgreSQL `127.0.0.1:54322`, project-scoped Docker network, with all four published services bound exclusively to `127.0.0.1`/`::1`. The [preflight record](benchmarks/phase-03/migration-verification/preflight.json) captures the actual container/project/port associations and migration checksum. There were no users, organizations, CRM records, jobs or sessions before reset. Residual Auth/security audits were identified as synthetic `@example.test` activity; they and local seed settings were privately preserved outside Git (directory 0700, file 0600). No production, staging, hosted or shared target was selected.

### A. Clean reset

`pnpm db:reset` successfully applied all 19 checked-in migrations, including the unchanged final Phase 03 file. The [clean catalog](benchmarks/phase-03/migration-verification/clean-catalog.json) verified three least-privilege roles, nine private RLS tables, eleven function owners/security modes/empty search paths, sixteen execution policies and expected allow/deny grants. The entire `pnpm verify:database` gate passed: 127 SQL/RLS assertions, 37 database test nodes, 20 Auth test nodes, 38 CRM test nodes and 22 automation/real-Auth HTTP test nodes, no advisor findings and no public type drift. The [check summary](benchmarks/phase-03/migration-verification/clean-checks.json) preserves the raw-log hash.

### B. Committed Phase 02F → Phase 03 upgrade

Reconstructed local migration `20261030212327` and verified all eighteen baseline SQL files byte-for-byte against commit `0ec8797`. Seeded two organizations, four memberships, five profiles, three contacts (including person/company and a foreign tenant), email/phone channels, three leads (assigned/qualified and closed/won cases), a source, three attributions, nine activities, a note, six durable receipts and CSV job/row/attempt records. Exact row and existing security snapshots were saved before applying Phase 03. The [before manifest](benchmarks/phase-03/migration-verification/upgrade-before.json) records counts and hashes.

Applied `migration up --local` to those records with **no reset between the successful seed and migration**. The verifier confirmed all 42 retained rows/relationships unchanged and existing policies, table grants and CRM/authorization function definitions intact. Manual and CSV replay preserved their original results; current assignment, search, lifecycle reopening with reason, stale-write rejection, member administration denial and cross-tenant denial remained operational. A new restricted integration reused the retained contact, produced one durable event and one version-bound internal workflow activity, and replayed without duplication. No retroactive events were backfilled. The [after record](benchmarks/phase-03/migration-verification/upgrade-after.json) captures these assertions.

The [upgraded catalog](benchmarks/phase-03/migration-verification/upgrade-catalog.json) has the same selected schema/security digest as the clean-reset catalog. Additional [integrity inspection](benchmarks/phase-03/migration-verification/upgrade-integrity.json) verified 75 validated constraints, including 23 foreign keys, nine primary keys and three exclusive creator-principal checks, plus the queue indexes. On this upgraded database, `pnpm db:test`, `pnpm test:automation`, `pnpm db:advisors` and `pnpm db:types:check` all passed again (127 SQL assertions and 22 automation/real-Auth HTTP test nodes). The independent full Auth/CRM/database regressions from path A were reused because the runtime/migration source and security catalog were unchanged; retained-record behavior was additionally verified in path B.

### Failures, corrections and evidence limits

No production application or migration correction was required in this follow-up. Verification-harness corrections addressed PostgreSQL `name[]` decoding, macOS temporary-directory aliases, JavaScript-array versus JSON RPC encoding, and required search defaults (now taken from the shared schema). Strict checks were retained. One migration was mistakenly advanced before the failed seed was inspected; that rehearsal is explicitly [marked invalid](benchmarks/phase-03/migration-verification/upgrade-discarded.json), its synthetic data was re-inspected, and the entire Phase 02F reconstruction/seed/upgrade was repeated in confirmed sequence. Only the corrected, fully seeded path counts toward acceptance.

Unrelated application/UI/unit/performance/dependency checks from the implementation milestone were reused. The new verifier and safe evidence artifacts received focused formatting/lint/secret checks. No hosted project, real communications, commit, push, merge or deployment occurred. Synthetic fixture records were removed after verification; raw state/audit evidence remains privately preserved. The 505 kB frontend bundle advisory and the separately documented production/provider prerequisites remain; they are not migration failures or claims of production readiness.
