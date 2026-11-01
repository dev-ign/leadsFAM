# Phase 03 developer and manual guide

Use synthetic `@example.test` identities and the existing local Supabase stack only. Nothing here connects Mirembe Cleaning or any real business. Its eventual inquiry, waitlist and booking events are represented by the first-party contract's neutral `eventKind` values. The source backend must be trusted; never embed an intake credential in a public site.

## Start and configure

1. Use `.nvmrc` (Node 26.13.0) and pnpm 12.16.1. Start Docker and `pnpm db:start`; its guard requires loopback-only publication.
2. Apply pending additive migrations using the pinned CLI's `migration up --local` through the existing project network wrapper. Do not use a hosted project. `db:reset` destroys local data and requires explicit authorization; both clean-reset and Phase 02F upgrade checks passed in the explicitly approved local verification session.
3. Run `pnpm dev` and, in another terminal, `pnpm worker:dev`. The local launcher creates separate mode-0600 temporary credentials for session, intake and worker roles outside the repository. No manual key configuration is needed for local development. Restart an already-running API after upgrading the launcher so it receives `INGRESS_DATABASE_URL`.
4. Open the local app, register/verify a synthetic account through local Mailpit, sign in and create a synthetic workspace. Only Owners/Admins manage integrations and automations.
5. Open Automations from the navigation. Create an automation, accept the default new-lead trigger and activity, or change the name/message. Optional source/status filters are collapsed. Review the summary, then Activate automation. Save draft is available if you want to finish later. Existing drafts can be reviewed and activated from the list.
6. Open Integrations. Name the integration; optionally choose an existing source. Add it and save the one-time key in backend secret settings. Dismiss its display. Ordinary reads never return it. Credentials expire after 90 days; Replace key immediately invalidates the old credential. An uncertain create must be reconciled by refreshing the list; replace a lost key rather than guessing whether creation failed.

Production does not use the local bootstrap. Before any approved deployment, provision the separate restricted login roles through the deployment secret manager and configure verified database TLS. `INGRESS_DATABASE_URL` belongs only to the API; `WORKER_DATABASE_URL` belongs only to the worker. Existing session credentials stay separate. No provider credentials or model keys are required.

## Submit, replay and inspect

Use [the synthetic contract](../../tests/fixtures/phase-03-inquiry.json). From a trusted backend, POST JSON to `/ingress/v1/leads` on the API with `Authorization: Bearer <one-time key>`. Browser Origin/cookie requests are rejected. Supply a stable `externalEventId`; no organization, source authority, actor, workflow or tool credentials belong in the payload. The integration resolves its own organization and source.

The result is `{ receiptId, leadId, contactId, correlationId, state: "succeeded", replayed }`. A 200 means CRM, attribution, receipt, event and any required dispatch intent committed together. It does **not** mean automation has finished. Refresh Integrations to see receipt/delivery problems, and Automations to see queued/completed/skipped/failed runs and safe references. Open the resulting lead to see the recorded activity and integration provenance.

Replay the identical fixture with the same key and event ID: `replayed` becomes true, with the same IDs and no extra activity. Change its title while retaining that ID: expect 409 `IDEMPOTENCY_CONFLICT`. First recorded attempts bind the canonical version-1 fingerprint even on business failure. For an explicitly corrected delivery that never succeeded, use a new event ID after review. Never change IDs merely because a response timed out: retry the original payload/identity first.

A new inquiry for an existing person uses a new event ID and `{ "mode": "existing", "id": "<reviewed contactId>" }`. The resulting lead is distinct. New-contact candidates require explicit review; no name/email/phone automatically links or merges people. `duplicateResolution: "create_distinct"` is an explicit producer attestation of that review, following the existing CRM contract.

## Failure and recovery

- Pause an integration: new intake and pending automation from it are denied. Resume reauthorizes it under the acting administrator. Revoke requires confirmation and cannot be undone; existing CRM records remain available. A revoked integration cannot be rotated/reactivated.
- Pause an automation: it stops unstarted effects. Editing saves a new immutable revision; active workflows keep the previous publication until activation. Already-triggered runs keep their original revision. The guided editor refuses unsupported configurations and preserves them without rewriting fields.
- Temporarily interrupt the worker and submit a lead: it remains durably queued. Restart the worker: due jobs are claimed. Ctrl-C performs a bounded graceful shutdown.
- For a reproducible actual crash **after** a claim, run `node --test --test-name-pattern='actual worker process crash' tests/automation/database.test.mjs` after building the API. It creates its own disposable fixture, SIGKILLs a worker and recovers the persisted claim in a new process. It advances only that synthetic lease clock to avoid a 30-second wait. In ordinary operation recovery waits for the real lease expiry.
- Automatic retries use bounded exponential backoff/jitter and at most five attempts. An expired final claim becomes terminal. Authority/validation errors terminate immediately. The worker never retries terminal work forever.
- Inspect Recent activity for retry timing and reference IDs. A failed dispatch or run offers Retry processing after the underlying issue is fixed. The request is version/fence checked, audited and independently reauthorized at execution. A retry cannot restore revoked publisher authority. Republishing under a current administrator affects future events; old revoked revisions remain denied.
- If the API times out after a commit, replay the original intake identity/payload. It is safe across API/worker restarts. Integration creation/rotation uncertainty requires refreshing status and replacing a lost key; keys cannot be recovered from hashes.

## Isolation and acceptance checks

Use a second synthetic workspace/account. Foreign lead/contact IDs must remain unavailable; management under another organization's URL returns the same 404 as an absent resource. Adding `organizationId` or `actor` to intake is rejected. A key is always bound to its original integration organization. A Member cannot access management controls; recovery/unenrolled sessions remain denied by the existing CRM context boundary.

Focused gates:

```sh
pnpm test:automation
pnpm --filter @leadops/web exec vitest run src/features/crm/crm.test.tsx
pnpm db:test
pnpm db:advisors
pnpm db:types:check
```

`verify:database` includes the existing database/Auth/CRM regressions and the new automation tests. The final cross-cutting milestone also needs formatting, lint, strict types, unit tests, build, dependency audit and secret scan. Do not rerun unaffected passing gates after documentation-only edits.

Synthetic measurements:

```sh
BENCHMARK_LABEL=phase-03 BENCHMARK_ROUNDS=3 node tests/performance/crm.mjs
node tests/performance/automation.mjs
```

Stop any independently running worker before the automation benchmark; it deliberately measures its own restricted worker. The benchmark/test harnesses remove only their own synthetic organizations and identities, using administrator-only teardown. Never point them at hosted or valuable data. Browser fixtures are separately cleaned up after verification. No database reset is needed for fixture cleanup.

Validate keyboard labels, review focus, dialog Escape/return focus, loading/error/retry states, and 375-pixel mobile plus desktop layouts in both themes. This focused review is not a complete assistive-technology or WCAG certification.

## Reproduce the two migration paths

The approved verification record is in [the report](phase-03-report.md#approved-final-migration-verification), with machine-readable evidence under `benchmarks/phase-03/migration-verification/`. The helper `tests/database/phase-03-migration.mjs` runs only when explicitly invoked and refuses non-local stack targets through the existing guard.

For a disposable, inspected local stack: run the standard clean reset, `node tests/database/phase-03-migration.mjs catalog clean`, then `pnpm verify:database`. For the upgrade path, reconstruct version `20261030212327` with the pinned CLI's local `db reset --version` option through `runLocalCLI`. Confirm that reset completed before continuing. Run the helper's `seed` command with a new state-file path inside the OS temporary directory, and confirm its successful completion and saved manifest. Apply pending migrations with local `migration up`, without resetting between the seed and upgrade. Run `catalog upgrade`, then `verify` with the same private state path. The verifier checks all retained rows/security snapshots before testing CRM behavior, creates one new workflow activity, and tears down only its own synthetic fixture records. Finish with focused RLS/automation/advisor/type checks.

Do not chain an upgrade after an unchecked background seed operation. Failed rehearsals must be investigated and excluded from acceptance evidence. Raw fixture/session state and audit backups stay outside Git in mode-0600 files; only safe hashes/counts/catalogs are retained in the repository.
