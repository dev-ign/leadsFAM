# Phase 02 implementation record

Approved scope: local CRM foundation only; no hosted resources, deployment, customer data, AI execution, commits or pushes.

## Gates

1. **02A**: reviewed privilege boundary, additive CRM schema and bounded database functions; ordinary-role/RLS tests, upgrade and reset verification, generated types, full Phase 01 regression.
2. **02B**: pinned normalization dependencies, strict contracts, typed repository/API services, contact/lead lifecycle and concurrency gates.
3. **02C**: executable retry contract before execution code; bounded CSV preview, explicit resolutions, transactional intake/import and real replay/race tests.
4. **02D**: limited data-router conversion, CRM UI, user/organization draft isolation, navigation/revalidation/cross-tab and browser checks.
5. **02E**: synthetic 1k/10k/50k benchmarks, plans and concurrency; full verification, audit/secrets, engineering report and learning guide.

## Baseline

Before CRM changes: `pnpm verify` passed (58 tests); `pnpm verify:database` passed (61 pgTAP, nine races, 20 Auth/API tests, advisors, type generation check). Node 26.13.0, pnpm 12.16.1, PostgreSQL 17.11. The working tree was clean at `99ae5d3ba385934b0a93b93798511844038feefa`.

ADR 0010 records the privilege review before applying a CRM migration. ADR 0011 records contact history and the three import identities before implementing execution. Gate results below must be filled from actual runs; pending work is not a pass.

## 02A gate

The upgrade from the Phase 01 checkpoint and a subsequent clean local database reset both succeeded. CRM adds seven public and four private relations, all RLS protected, without altering either Phase 01 migration. Generated public types were refreshed. The CRM role has no inherited roles, no Auth schema usage, no session-store access and no ownership of tables.

`pnpm verify` passed (58 code tests). After clean reset, all existing 61 pgTAP assertions, nine races and 20 real Auth/API tests passed. The final SQL run passed 114 assertions, including 53 CRM boundary and contact-history assertions. Advisors returned no findings and generated types matched.

## 02B implementation

Pinned `libphonenumber-js` 1.13.15 installed successfully under strict peer/engine policies, with no dependency warnings. Its published TypeScript declarations work with TypeScript 6 strict library checking; an exact-optional-property error in our call adapter was corrected without disabling checks. Local phone numbers without explicit region remain unmatched, international numbers/extensions are validated, and email plus/dot syntax is preserved. No Supabase SDK was reintroduced.

Typed user-JWT RPC transport now lives in the database package. The API retains application authorization and safe error mapping. Contact CRUD, conservative candidate review, source management, lead mutation, transition, archive and assignment endpoints enforce the same rules through direct RPC. All event actors and timestamps are server-derived. API routes use the existing session, Origin and CSRF hooks; CORS adds PUT and the idempotency header.

Seven initial CRM database scenarios and seven real Auth/CRM HTTP tests passed. The additional queued-demotion race and complete gate run are pending below. Integration and race suites are included in `verify:database`, including CI. Administrator-only cleanup targets fixture UUIDs and disables triggers only inside its synthetic-data teardown transaction; the application roles receive no delete capability.

The final 02B gate passed: 63 code tests, 114 SQL assertions, 17 database scenarios (nine existing and eight CRM), 20 identity tests, seven CRM HTTP tests, advisors and generated types. Dependency audit: no known vulnerabilities. A Vitest 5 filesystem-cache invalidation race (`ENOTEMPTY`) was fixed using its supported per-package cache path; no tests were disabled or serialized away.

## 02C pre-execution contract gate

`node --test tests/crm/import-spec.test.mjs` passed nine tests **before** implementing a database import function or HTTP execution route. The independent reference model and reusable observable contract cover immutable attempt replay, corrected attempts, successful delivery preservation, manifest identity conflicts, response loss and competing attempts. The same assertions must next pass against PostgreSQL; a model pass alone is not evidence that the implementation works.

The final 02C gate passed: 74 code tests, 121 SQL assertions, 33 database tests, 20 identity tests and 28 CRM/specification tests. The latter comprise seven existing HTTP tests, nine reference-model tests and 12 import HTTP tests, including an actual API process restart after commit with the response discarded. Advisors and generated type comparison passed. Dependency audit reported no known vulnerabilities. Gitleaks canaries, working tree and history scans passed with no leaks.

`csv-parse` 7.0.3 installed with pinned integrity under strict peer/engine rules and passed strict TypeScript checks. CSV preview writes no records, uses one bounded candidate RPC, detects intra-batch matches and retains delivery IDs when reviewing an existing job. Both unresolved matching rows fail safely; an explicit create-distinct correction uses a new attempt. A synthetic infrastructure failure rolls back the entire job/attempt and business writes. Contacts are locked by UUID before executing rows; overlapping manifests and reversed contact order complete without deadlock.

02C failures resolved: the direct PostgreSQL test adapter needed explicit JSON encoding for array parameters; an ambiguous SQL output column was corrected with an additive migration; parallel HTTP test processes exposed a local bootstrap role-password race, now guarded by a transaction advisory lock covering local secret-file initialization and role setup. Only bootstrap is serialized; business concurrency tests remain parallel. No peer checks, library checks, tests or security warnings were suppressed.

Earlier 02A failures resolved: ownership transfer required a temporary CREATE grant revoked before migration completion; the SQL test harness required test-only pgTAP schema usage for the non-inheriting CRM role; an administrator-owned test connection cannot accurately simulate SET ROLE denial, so the assertion checks the actual SET membership grant instead; advisors found repeated scope evaluation, resolved by a separate additive migration caching only the request-constant scope.

## 02D gate

Passed `pnpm verify`: 90 code tests (six boundary, 43 API, 36 frontend, two shared and three UI), strict types, lint, formatting and builds. Passed `pnpm verify:database`: 121 SQL assertions, 35 database scenarios, 20 identity tests and 35 CRM/specification tests, no advisor findings and no type drift. Route splitting reduced the initial JavaScript bundle from 555.19 kB to 499.79 kB (152.37 kB gzip) and removed the build warning without raising its threshold.

The added frontend tests cover scoped drafts, focus/cross-tab revalidation, revocation, identity and role changes, navigation/refresh warnings, sign-out confirmation, uncertain-create replay, late query responses, filters/cursors, empty/error states, member permissions, original edit versions and visible form submission. They exposed and corrected a double navigation and stale organization verification race. Browser checks additionally verified creation, assignment, qualification, close/reopen with retained reason, shared-contact edits, preserved phone region/original formatting, archive/restore, source creation, native CSV upload, mapping, explicit existing-contact selection and a corrected partial retry. Database readback confirmed four leads, three contacts, three successful row deliveries and two attempts; original successful lead IDs were unchanged.

Responsive checks used desktop and mobile viewport overrides, then reset them. Mobile table overflow stayed inside its container; navigation Escape restored focus. Light and dark themes rendered. Screenshots contain synthetic records only. The IAB did not expose a native refresh confirmation dialog; automated tests verify the cancelable `beforeunload` event, and a standard-browser manual check remains documented. Local development required forwarding macOS `TMPDIR` through Turbo so dev and test bootstrap use the same local secret file. No production session behavior changed.

Source catalogs are capped at 100 records under a database lock. Candidate input bounds and static constraint errors prevent raw contact data appearing in PostgREST error detail. Readiness probes check runtime SQL, Auth and PostgREST, return only ready/unavailable and have bounded responses. The pool's existing connection/statement deadlines still govern an SQL probe that outlives the readiness response.

## 02E gate

All additive migrations passed a final clean local reset. Final `pnpm verify` passed with 91 code tests, strict types/lint and builds; `pnpm verify:database` passed 121 SQL assertions, 35 database scenarios, 20 identity tests and 36 CRM/specification tests, no advisor findings and no generated type drift. Dependency audit reported no known vulnerabilities; secret canaries, working tree and history scans passed without leaks. Phase 02 has no remote CI run because no commit/push was authorized.

The final scale run follows the clean reset and records 1k/10k/50k target organizations plus actual global row counts and ordinary-role plans. At 50k, p95 listing/contact email-prefix/detail/timeline was 67.5/19.0/16.4/15.5 ms. Title prefix (377.2 ms) and combined filters (1,085.4 ms) miss the initial 300 ms target; broad contains timed out in all sixteen warmup/measured requests. These are retained limitations. Final sequential/burst 100-row imports topped out at 598.4/2,103.0 ms. See the performance report for distributions, small-sample limits, failures and prior comparisons. No RLS or Phase 01 authorization check was removed for performance.

At completion, the user requested the project engineering-efficiency policy. Root AGENTS.md and the existing project-local skill were minimally refined by inspection only. No tests, builds, migrations or resets were started for that configuration task. Passing Phase 02 results were retained; subsequent documentation does not justify another full regression run. CI and critical coverage remain intact.
