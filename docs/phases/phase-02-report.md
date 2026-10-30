# LeadsFam Phase 02 engineering report

Date: 2026-10-30. Scope: approved local CRM foundation, increments 02A–02E. Implementation and required verification are complete, with the performance and manual-browser limitations below. This is not a production-readiness certification. Phase 03 has not begun.

## Delivered

Contacts and leads are distinct organization-owned records. Person/company contacts support bounded multiple channels and explicit duplicate review; each lead requires a contact. Repeat inquiries create separate leads. Current contact details resolve consistently across related leads while immutable attribution and activity retain historical meaning.

The API/UI support contacts, lead creation/editing, the four-state lifecycle, closing outcomes, Owner/Admin reopening reasons, eligible assignment, reversible archive/restore, source management, server filters/search/sort/keyset pagination and activity timelines. CSV has native upload/paste, explicit mapping, stateless preview, candidate review, partial success, corrected attempts and durable result retrieval.

Versions prevent lost updates. Database locks and composite tenant foreign keys preserve authorization order and referential integrity. Manual intake and CSV deliveries have transactional durable receipts. The frontend uses the existing centralized typed client and a limited data-router conversion. New CRM drafts are memory-only and verified-user/workspace scoped; late responses cannot populate another scope.

No hosted resources, real customer data, external integration, AI execution, deployment, commit or push occurred. Internal `@leadops` scopes remain. The initial working tree was clean on `main` at `99ae5d3ba385934b0a93b93798511844038feefa`; Phase 01's committed/pushed checkpoint was verified before implementation. Current work remains uncommitted for review.

## Increment gates and actual results

The baseline passed before CRM work. A focused privilege review preceded the first CRM migration. The executable import retry specification passed before execution was implemented, then the same contract passed PostgreSQL and HTTP implementations. Stages were validated before proceeding; details and fixes are retained in [the incremental record](phase-02-progress.md).

| Final check              | Actual result                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`            | Passed formatting, package boundaries/lint, strict TypeScript, code tests and production builds                            |
| Code tests               | 91 passed: six boundary, 43 API, 36 web, three shared and three UI                                                         |
| Clean local reset        | Passed with all additive CRM migrations; prior Phase 01 → 02A upgrade and subsequent local migration upgrades also passed  |
| `pnpm verify:database`   | Passed after reset and final performance changes                                                                           |
| SQL/RLS assertions       | 121 passed across the existing tenant suite and CRM boundary suite                                                         |
| Database scenarios       | 35 passed, including existing races, CRM lifecycle/CAS/assignment and transactional import races/contracts                 |
| Real identity/Auth tests | All existing 20 passed, including recovery credential isolation and refresh/revocation failure behavior                    |
| CRM/specification tests  | 36 passed, including real authenticated HTTP, import specification, process restart, cursors and prefix/contains semantics |
| Advisors/generated types | No advisor findings; no public schema type drift                                                                           |
| Dependency audit         | No known vulnerabilities reported; high/critical remain blocking                                                           |
| Secret scanning          | Provider/session/database canaries detected; working tree and two-commit history scanned, no leaks reported                |
| GitHub Actions           | Existing comprehensive jobs preserved; Phase 02 was **not** pushed/run remotely, so no remote CI success is claimed        |

The final JavaScript entry is 499.95 kB minified / 152.40 kB gzip, with CRM/auth/status route chunks loaded separately. A 555.19 kB warning prompted route splitting; the warning threshold was not raised. `libphonenumber-js` 1.13.15 and `csv-parse` 7.0.3 were pinned and installed under strict engines/peers with no dependency-conflict bypass. Their actual declarations passed strict TypeScript 6 library checks. No SDK/ORM, Redis, worker or speculative package was added.

Passing checks were reused when only documentation/instructions changed at completion. The requested efficiency-policy task was inspection-only: only root `AGENTS.md` and the project-local smart-test-strategy skill were minimally refined. No tests/builds/resets were started for that configuration task, and no CI/test-runner/script change was made to reduce verification.

## Database and security evidence

All eleven CRM relations have RLS and administrator ownership. The CRM function owner has NOLOGIN/NOBYPASSRLS, no inherited roles, no Auth schema/table access, no session ciphertext or recovery-fence access and no Phase 01 mutation-helper authority. Public direct writes and private ledger reads are denied. Explicit function ownership, grants and empty search paths are tested. Composite tenant references, immutable tenant/creation identity, activity/attribution protection and bounded source/channel constraints are enforced independently of HTTP.

Authentication, authorization and isolation remain separate responsibilities. The API verifies the existing application session and resolves requested organizations from current membership; database entry points recheck session/membership/permission under the organization lock. Recovery and unenrolled credentials cannot read ordinary organization/CRM data. No Phase 01 authorization policy, session architecture or Auth privilege was expanded. Shared presentation permissions were centralized with the same Owner/Admin/Member outcomes; PostgreSQL remains authoritative.

Concurrency tests cover competing edits/status changes, assignment vs revocation, queued admin demotion, active-request/revocation ordering, duplicate contact creation, reversed import contact order and overlapping delivery claims, alongside existing owner/invitation races. An admitted operation may finish before revocation; one queued behind a winning revocation must fail. Historical assignment generations cannot reactivate when a member rejoins.

Safe logging excludes bodies, search terms, contact PII, cursor bodies and reasons. Constraint errors preserve safe codes while discarding failing-row detail. Local PostgreSQL error-parameter logging was verified disabled. Human-entered reopening reasons and URL paths remain intentional business content and can contain sensitive information; they are not anonymized by this design.

## Import and failure evidence

The contract distinguishes a batch job, an immutable attempt and a logical delivery. Identical attempts replay their stored results; incompatible reuse conflicts. Corrections use a new attempt and original delivery IDs. First successful delivery IDs cannot create another lead, including after partial failure, repeated submission or process restart.

Tests cover invalid manifests, cross-job/cross-tenant identities, changed successful rows, competing attempts, expired/revoked authority and an unexpected database failure that rolls back the entire attempt. A child API process was terminated after the transaction committed with the response discarded; a new process using the same authorized session recovered the original result without recreating rows.

CSV is bounded to 256 KiB UTF-8 text, 100 rows, 16 mapped columns and bounded fields/records; import JSON alone permits 512 KiB. No formula execution, export, raw CSV persistence or external fetch/send exists. Larger batches require a separately reviewed durable background design. A timeout does not prove rollback: uncertain submissions retain their payload/identity for replay.

## Measured performance and remaining issues

The [performance report](benchmarks/phase-02-final/README.md) preserves environment, distribution, concurrency, raw samples, actual global row counts and `EXPLAIN (ANALYZE, BUFFERS)` plans at approximately 1k/10k/50k target leads. It uses four real application sessions and real Auth/PostgREST; Fastify injection excludes browser and client TCP/TLS. Twelve measured samples per read make p95 the sample maximum, not a robust production SLO.

At 50k, final p95 was 67.5 ms for listing, 19.0 ms for contact email-prefix search, 16.4 ms for detail and 15.5 ms for timeline. Lead title-prefix search was 377.2 ms and the combined status/source/assignment filter was 1,085.4 ms: both miss the initial 300 ms target. Broad substring search failed all sixteen warmup/measured requests at the five-second deadline. This is an unresolved performance limitation, not a passed latency target. Default indexed prefix search remains usable; broad prefixes can also produce large candidate sets.

Final 100-row jobs took at most 598.4 ms sequentially and 2,103.0 ms in the four-job burst, meeting the initial three-second batch target in this run. Earlier comparisons and failures remain recorded. The initial import timeout was removed by avoiding unnecessary matching after an explicit create-distinct decision. Parameter-specific plans, native prefix indexes and candidate/source joins improved reads without removing volatile RLS/session checks or adding infrastructure. No membership authorization cache or leakproof reclassification was introduced.

Before customer rollout, further profile substring and combined-filter workloads against expected data and sustained concurrency. Local figures do not establish p99, cold-cache, remote or production capacity. No unresolved critical security finding was identified by the completed checks; that does not eliminate the operational limitations below.

## Browser verification and limitations

Actual browser checks covered lead/contact creation, assignment, qualifying/closing/reopening with retained reason, current shared-contact edits, preserved phone formatting/region, source creation, archive/restore and CSV native upload/mapping/partial corrected retry. Database readback confirmed one manual plus three imported leads, three contacts, three successful deliveries and two attempts, preserving the original successful IDs.

Desktop/mobile layouts and light/dark themes rendered. Mobile table scrolling stayed inside its container; menu Escape restored focus. Automated component tests verify dirty navigation, same-user focus/cross-tab preservation, logout/user/role/revocation/workspace isolation, original edit versions, uncertain retry, stale responses and permission-aware behavior. Screenshots contain synthetic records only; the final reset removed the earlier disposable browser fixtures.

IAB did not expose a native browser refresh-confirmation dialog during automation. The cancelable `beforeunload` handler passed its test; standard-browser warning behavior remains a manual check. Memory-only drafts can be lost on hard refresh. A confirmed discard cannot cancel a business transaction already sent. Contact detail displays the latest 25 related leads, with complete pagination available through the API. Existing Phase 01 note/settings forms were not converted into the new CRM draft mechanism.

## Operational boundaries and next steps

Local ports remain loopback-only. Production still needs reviewed HTTPS/CSP/proxy topology, managed keys/TLS, two-stage session key rotation and a distinct cursor key, distributed/gateway abuse limits, Auth onboarding policy, backups/restore, monitoring, retention/deletion/export, consent and incident procedures. In-memory API rate limits do not protect direct Auth/PostgREST access or coordinate multiple instances. Database administrators, runtime memory, keys and backups remain privileged boundaries. No legal/compliance certification is claimed.

Readiness checks only restricted SQL/Auth/PostgREST availability; they do not certify policy correctness or production readiness. A timed-out readiness response does not cancel an already queued SQL probe; existing pool deadlines bound it. No retention purge or application hard deletion exists, and durable receipts must not be casually expired because doing so can permit duplicate recreation.

The [manual/migration guide](phase-02-manual.md) contains startup, clean-reset, lifecycle, duplicate-review, two-tab conflict, security/draft, CSV retry and repeatable benchmark steps. The [learning guide](../learning/phase-02.md) explains the important decisions in plain English; [CRM architecture](../architecture/crm.md) documents schema, permissions and API contracts. [The future-agent ADR](../decisions/0014-future-agent-crm-boundary.md) keeps future tools backend-authorized and provider-independent without implementing agent execution.

Phase 02 stops here. Review the uncommitted changes and known performance limitations before any separately approved release or Phase 03 work.
