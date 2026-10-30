# Phase 02 local verification and migration guide

Use synthetic data only. No cloud setup, customer data, deployment, commit or push is included. Docker Desktop must have appropriate licensing and localhost-by-default publication configured as approved in Phase 01. The project verifies actual published addresses; stop if a wildcard listener appears.

## Start and verify

From the repository root:

```sh
source ~/.nvm/nvm.sh
nvm use
pnpm install --frozen-lockfile
pnpm db:start
pnpm db:bindings:check
pnpm verify
pnpm verify:database
pnpm audit:dependencies
pnpm scan:secrets
pnpm dev
```

Open `http://127.0.0.1:5173`. The API runs at `http://127.0.0.1:3001`; confirm the configured API port in `.env.example` if changed. `/health` should return liveness; `/ready` should return ready only while local SQL/Auth/PostgREST respond. Mailpit is `http://127.0.0.1:54324`, Studio `http://127.0.0.1:54323`. Keep these loopback-only.

Create a synthetic account using an `@example.test` address and a new local-only password. Verify using the six-digit email in Mailpit. Create a workspace. Use a second synthetic account plus an invitation to test Member actions. The browser fixture used during implementation is disposable; no password is included in version-controlled docs. A reset removes it.

## Migration discipline

The Phase 01 migrations remain unchanged. Phase 02 adds migrations beginning `20261030042302_crm_foundation.sql`; later additive files repair local findings and introduce query/index optimizations. Apply all in filename order. SQL function replacements preserve their reviewed owners and ACLs; they do not grant new Auth/session access. Never cherry-pick only the last file.

For an existing **local** Phase 01 database, stop the dev API first, then apply pending migrations with the configured local bridge:

```sh
SUPABASE_TELEMETRY_DISABLED=1 pnpm exec supabase migration up --local --network-id leadsfam-local-1e261f683484
pnpm db:types
pnpm verify:database
```

The bridge name is derived from this checkout path; `scripts/local-stack.mjs` exports the actual `networkName`. Do not copy this machine-specific bridge name into a different checkout. Prefer the repository wrappers for startup, reset, types and checks; they suppress credential output and verify locality. For new migrations use `pnpm exec supabase migration new descriptive_name`; do not hand-invent timestamps or edit applied history.

A clean reset is destructive to this project's local database, including all local accounts and synthetic records. Run it only on this disposable stack, after saving any work you need:

```sh
pnpm db:reset
pnpm verify:database
pnpm dev
```

A local upgrade and clean reset were both tested. Production rollout/backfill, backups, key management and rollback require their own approval and runbook; none was attempted. Generated stored search columns/index creation rewrites/indexes populated tables and is appropriate only with a deliberate maintenance plan for a future hosted rollout.

## Contact and lead workflow

1. Open Contacts → New contact. Create a person with a display name, email and `(202) 555-0123` with region `US`. Leave channels absent on a second contact. Create a company with a company name. Confirm the three-channel limit and primary position.
2. Create a lead by explicitly selecting an existing contact, then another lead referencing it. Try a matching email/name on a new contact: review candidates and explicitly reuse or create distinct. No record should auto-link.
3. Edit the shared contact's display name. Both lead views should show the current name. Its original phone formatting/region should survive; original attribution timestamps and prior events should not change.
4. Assign an open lead to an active member. Qualify it, close with an outcome, then reopen as Owner/Admin with a reason. Check the timeline and retained reason. As Member, verify ordinary transitions and self claim/release work, while sources/import/archive/reopen controls are unavailable and API attempts are denied.
5. Open the same edit in two tabs. Save in the first, then submit the second. Expect a version conflict and retained unsaved text; refresh/discard deliberately before reapplying changes.
6. Archive/restore a lead. Try archiving its contact while another open, unarchived lead still exists: expect refusal. Revoking/reinviting an assignee must not reactivate their historical assignment automatically.
7. Search with “Starts with” using the beginning of a name/title/email or E.164 phone including `+`. Switch to “Contains anywhere” for an interior word. Apply status, source, assignment, date, archive and order filters. Page forward/back with stable timestamp/UUID ordering. A changed filter starts at the first page. Broad substring search may hit the bounded timeout at 50k; see measured limitations in the report.

## Draft and accessibility checks

Type a private synthetic name, navigate away, choose Keep editing, then repeat and explicitly Discard. Try Sign out while dirty. Focusing the tab or broadcasting a same-user session change from another tab should preserve fields and their original edit version. Logging out/changing users/revoking membership must hide/discard the old form. Switching workspaces must not display its text, including after a slow old save finishes.

In a standard browser after typing, refresh/close the page: expect the browser's unsaved-change warning when supported. Choosing Stay keeps the draft; accepting refresh loses memory-only text. IAB did not expose its native dialog during automated verification, so this remains a manual browser check; the cancelable `beforeunload` handler is tested automatically. Sensitive data must not appear in localStorage/sessionStorage; theme preference alone is expected.

Use keyboard Tab/Shift-Tab through inputs/buttons and the skip link. On mobile width, open navigation, close with Escape and verify focus returns to the trigger. The table may scroll inside its container; the whole page should not overflow horizontally. Check light/dark themes and loading, empty, retry and conflict messages. The native unsaved-change dialog defaults focus to Keep editing.

## CSV partial retry and recovery

Upload [the synthetic CSV fixture](../../tests/fixtures/phase-02-manual.csv), or paste it. Explicitly map Name → Display name, Opportunity → Lead title, Email → Primary email, Priority → Priority. If Jordan already exists, choose the existing candidate. The intentionally invalid priority should be visible as a safe row error. Execute: two rows should succeed and one fail.

Save the job URL and original successful lead IDs. Review remaining rows, change only the invalid priority to `normal`, retain original row order, read/map/preview again, then execute a new attempt. Only the remaining delivery should create a lead. Successful rows stay locked; the original IDs remain unchanged. Refreshing the job URL should still show saved results without a stored raw CSV. Do not generate a new job to “retry” an uncertain attempt.

Try malformed headers, duplicate mappings, 101 rows, non-UTF-8 data, oversized files/fields and another workspace's IDs. Expect safe bounded failures, no raw values in error payloads/logs and no partial business writes on an infrastructure failure. The automated suite additionally verifies an actual API process restart after commit with the response discarded, competing attempts and reversed contact locks.

## Repeat scale measurements

Stop other test suites and CPU-heavy work for a cleaner comparison. Keep the local stack running. The script refuses non-loopback Supabase endpoints, creates only its own fixture organizations/users, seeds synthetic data using administrator access, times independently authenticated application requests, and cleans its fixture UUIDs in `finally`.

```sh
pnpm exec turbo run build --filter=@leadops/api
BENCHMARK_LABEL=local-review node tests/performance/crm.mjs
```

It writes raw samples, environment/distribution and `EXPLAIN (ANALYZE, BUFFERS)` JSON under `docs/phases/benchmarks/local-review`. For a quicker diagnostic, `BENCHMARK_SIZES=1000` selects the smallest approved size. This is an explicit slower manual gate; it is not a silently disabled correctness test. CI runs all code, SQL, Auth/API, race, advisor and type-drift checks, while scale measurements are retained as engineering evidence rather than flaky timing assertions.
