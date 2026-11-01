# Phase 04 final client acceptance report

## Environment and tested revision

- Run: **P04AT-20261101200343-52d449**, November 1, 2026, **3:03–3:16 PM EST** (`America/New_York`).
- Branch: `codex/phase-04-communications`.
- HEAD/base commit: `2a329e633ba5b0137cd88cadc135fa4ae660e7cd`. Phase 04 remains uncommitted; this report evaluates the existing working tree, not a new commit or remote CI run.
- Tested-source fingerprint: `bb0d77e0cc7154dfe98c208eae343b42d581d8ec141833aac7d69a15b88a58cb`, a SHA-256 digest of the manifest of 178 application/package/database/script/test source files. The manifest was identical before and after acceptance.
- Local web `127.0.0.1:5173`, API `127.0.0.1:3001`, Supabase API `127.0.0.1:54321`, PostgreSQL `127.0.0.1:54322`, Mailpit `127.0.0.1:54324`. Existing loopback-binding assertions ran before fixture setup, inspection, worker passes and cleanup.
- Existing API PID **46573** and web PID **47525** remained running with the same PIDs afterward. No user-owned process/database service was stopped.
- CLI verification used pinned Node 26.13.0 and pnpm 12.16.1. Browser: actual in-app browser, a separate temporary test tab, default 1280 CSS-pixel desktop and explicit **375 × 812 CSS-pixel** mobile viewport. The original viewport was restored before closing the tab.
- Workspace: **FreshNest Acceptance P04AT-20261101200343-52d449**, created through the UI, ID `62e671dd-b323-40c5-8c04-5c34db8319d8`.
- Newly created local test identity: `crm-b442caeb-c960-4108-9193-3db4cb66725b@example.test`, user ID `f264ffd0-7f54-496c-8112-4429cd8b9f2a`, Owner of this new workspace. Fixture identity provisioning used the existing local Auth/Mailpit harness; the business journeys below used the application UI.

Preparation included root `AGENTS.md`, the installed smart-test-strategy skill, the Phase 04 engineering report, manual and architecture documentation. This was acceptance testing only: **no application source, architecture, dependency, migration or production configuration changes** were made. This run added only this acceptance report and evidence files.

## Eight-test result summary

| Test                          | Result                           | Expected                                                                                                             | Observed                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Contact creation          | **PASS**                         | Save/reopen the specified contact in the isolated organization with communication entry points.                      | Jordan persisted with the exact email, normalized phone and US region. Reopened through Contacts; Compose message and View message history were present.                                                                                                                                                            |
| 2 — Persistent email draft    | **PASS**                         | Recipient, subject, purpose, body and identity survive navigation.                                                   | Saved, left through Conversations, selected Jordan’s email conversation, and reopened the same message UUID with exact content intact.                                                                                                                                                                              |
| 3 — Consent and authorization | **PASS**                         | Missing consent blocks sending; evidence changes eligibility; a current administrator must explicitly approve.       | Send was disabled even with the approval checkbox checked before consent. Separate evidence made the recipient eligible, but unchecked confirmation still blocked sending. Owner explicitly confirmed the saved version.                                                                                            |
| 4 — Mock email lifecycle      | **PASS**                         | One approved intent/job progresses through queue, acceptance and simulated delivery.                                 | Browser separately showed queued, submitted and delivered. One durable job and one submission-start event; expected lifecycle events were visible in processing history.                                                                                                                                            |
| 5 — SMS permission separation | **PASS**                         | Email consent does not authorize SMS; separate SMS evidence enables mock processing.                                 | SMS remained disabled despite email consent. SMS evidence, explicit approval and two worker passes produced its own delivered message/job/history.                                                                                                                                                                  |
| 6 — Destination suppression   | **PASS**                         | A block overrides consent; removal does not manufacture new consent.                                                 | Granted consent remained visible while sending was disabled by an administrative block. Removal restored eligibility. Before/after consent rows and IDs were identical. No job was created for the blocked draft.                                                                                                   |
| 7 — Pause/resume              | **PASS**                         | Paused work is not submitted, is retained, and resumes without duplication.                                          | A worker pass while paused left the same message queued, attempts zero, and no submission event. After UI unpause, the same job progressed to submitted and delivered.                                                                                                                                              |
| 8 — UX/error recovery         | **PASS, with one minor finding** | Usable navigation, validation, explicit confirmation, focus/keyboard behavior, narrow layout and recoverable errors. | Required-field validation focused Subject; invalid-recipient and paused errors preserved content. Save focused review. Space/Tab/Return approval worked. Both inspected mobile views measured 375/375 CSS pixels without overflow, with no unlabeled form controls. A stale pause-error notice is documented below. |

No test above is marked PASS solely on HTTP status. Each business journey was operated through visible browser controls and its result was inspected in the application. Database inspection supplemented persistent-state, identity, job and evidence assertions.

## Exact browser actions and evidence

### Test 1 — Contact creation

1. Opened the local app, entered the newly provisioned test identity, and clicked **Sign in**.
2. Entered the run-specific workspace name and clicked **Create workspace**. The new workspace opened; no pre-existing organization was selected for mutation.
3. Used **Workspace pages → Contacts → New contact**.
4. Entered **Jordan — Phase 04 Acceptance**, email **phase04-jordan@example.test**, phone **+12025550123**, country **US**, and clicked **Save contact**.
5. Clicked **Back to contacts**, found Jordan in the list, and clicked Jordan’s name to reopen.
6. Confirmed the contact heading, email, phone, **Compose message**, and **View message history**. Final tenant-scoped database inspection confirmed stored phone region `US` and the same organization ID.

Evidence: [reopened contact](01-contact-reopened.png); `email-draft-initial` and `final-before-cleanup` snapshots in [run.json](run.json).

### Test 2 — Persistent email draft

1. From Jordan, clicked **Compose message**; selected **Email** and **Service or transactional**.
2. Entered subject **Your FreshNest cleaning appointment** and body **Hello Jordan! This is a synthetic test of your cleaning appointment confirmation. No actual appointment has been scheduled.**
3. Clicked **Save draft**. Verified focus on **Review saved message** and the visible saved-draft link.
4. Navigated through **Workspace pages → Conversations → Jordan — Phase 04 Acceptance · Email → Open draft**.
5. Inspected the reopened form: same recipient, purpose, exact subject/body and UUID `255e7f36-40bd-44bb-b604-382408c193cc` in the Open draft route. Initial persistence was version 1, with no delivery job or consent row.

Evidence: [reopened draft](02-email-draft-reopened.png); initial persisted snapshot in [run.json](run.json).

### Test 3 — Consent and explicit authorization

1. Checked the explicit review/authorization checkbox before any consent existed. The **Confirm and queue mock message** button remained disabled; the UI said to record explicit permission. No delivery job existed.
2. As an error-recovery check, changed Recipient to **not-on-contact@example.test**, clicked **Save draft**, and observed **The destination is not on this contact** with sending disabled. Subject/body were preserved. Restored **phase04-jordan@example.test** and saved again. These intentional edits account for the draft-updated events and version progression to 3.
3. Expanded **Record permission evidence** and entered source **Synthetic FreshNest service request**, collection **November 1, 2026 at 12:00 PM EST** (`17:00Z`, in the past), country **US**, policy **synthetic-service-v1**, evidence **synthetic-manual-fixture-only**.
4. Clicked **Record explicit permission** and observed **Eligible under the explicit-permission mock policy** and the granted evidence summary.
5. Verified the queue button was disabled while confirmation was unchecked. Used **Space** on the approval checkbox, **Tab** to the queue button, and **Return**. Because a new workspace starts paused, the app correctly showed a paused-sending error and kept the draft intact; no job was created.
6. Navigated to **Conversations → Communication settings**, cleared **Pause new submissions**, clicked **Save sending controls**, and observed **Mock sending: enabled**. This modified only the acceptance workspace’s mock control.
7. Returned through the email conversation’s **Open draft**, explicitly checked confirmation, and clicked **Confirm and queue mock message**. The Owner approved saved version 3; the queued record became version 4. The app displayed **Message queued for mock delivery**.

Evidence: [missing-consent block](03-consent-blocked.png), [invalid recipient with content retained](08-invalid-recipient-preserved.png), [permission and recoverable pause error](03-permission-and-pause-feedback.png), and consent/approval snapshots in [run.json](run.json).

### Test 4 — Mock email lifecycle

1. Kept all test-owned workers stopped until after browser approval. Clicked **View delivery status and history**, observed **Outgoing email · queued**, and captured it.
2. Confirmed the single pending job, then started a test-owned one-pass process using the existing restricted `AutomationDatabase` and production communication dispatcher with its deterministic mock adapter. It refused to claim if another tenant had pending/claimed communication work. It never claimed automation work.
3. Clicked **Refresh status** and observed **submitted**, distinct from delivery.
4. Ran the next due reconciliation pass, clicked **Refresh status**, and observed **delivered**, alongside **All provider results shown here are simulated**.
5. Expanded **Processing history**. Visible events included draft created, draft updated, send requested, authorization granted, queued, submission started, provider accepted and delivered.
6. Persisted inspection confirmed one job for this message, attempts 2, generation 2, final state `done`, and exactly one submission-start/acceptance/delivery sequence. There was no external provider operation.

Evidence: [queued](04-email-queued.png), [submitted](04-email-submitted.png), [delivered and events](04-email-delivered-history.png), [final full browser evidence](final-email-acceptance.png); message/job/event snapshots in [run.json](run.json).

### Test 5 — Independent SMS permission

1. Clicked **Prepare another message**, selected **SMS**, and entered **Hello Jordan! Your FreshNest synthetic appointment test is ready.** The selected recipient was `+12025550123`; there was no email subject.
2. Clicked **Save draft** and checked confirmation. Sending remained disabled with **Record explicit permission** despite Jordan’s existing email evidence.
3. Recorded separate SMS evidence: source **Synthetic FreshNest SMS service request**, same valid past collection time, US, `synthetic-service-v1`, and `synthetic-manual-fixture-only`.
4. Observed SMS eligibility, explicitly unchecked/rechecked confirmation, and clicked **Confirm and queue mock message**.
5. Opened history and observed queued. Ran one test-owned worker pass, refreshed to observe submitted, then ran the next due reconciliation pass and refreshed to observe delivered.
6. Expanded SMS processing history. Persisted inspection confirmed a distinct SMS message/job, separate email and SMS evidence records, two attempts, and the expected lifecycle. Draft updated was not applicable because this SMS draft was not edited after its first save.

Evidence: [SMS denied with only email consent](05-sms-consent-required.png), [SMS submitted](05-sms-submitted.png), [SMS delivered/history](05-sms-delivered-history.png); SMS/evidence snapshots in [run.json](run.json).

### Test 6 — Destination suppression

1. Used **Contacts → New contact**, entered **Alex — Phase 04 Acceptance**, email **phase04-alex@example.test**, and clicked **Save contact**.
2. Clicked **Compose message**, saved subject **Phase 04 suppression test** and body **Hello Alex. This is a synthetic suppression acceptance test.**
3. Recorded synthetic email/service evidence through the same UI and verified eligibility.
4. Clicked **Block this destination**, then checked review confirmation. The app displayed a blocked-destination explanation; the queue button stayed disabled while previously granted consent remained visible.
5. Scoped inspection confirmed one `administrative` suppression and no delivery job for this draft.
6. Clicked **Remove administrative block**. The app returned to eligible and the queue button became available. Did not send this draft.
7. Compared every consent row and ID before the block and after removal: identical. No consent was inserted, revoked or altered by block removal.

Evidence: [suppression wins over consent](06-suppression-overrides-consent.png), [administrative removal](06-administrative-block-removed.png); `suppression-before-block`, `suppression-active`, and `suppression-removed` snapshots in [run.json](run.json).

### Test 7 — Pause and resume

1. Clicked **Start another draft** to create a new identity, leaving the suppression-test draft unsent. Entered subject **Phase 04 pause and resume test** and body **Hello Alex. This synthetic message must remain queued while submissions are paused.**
2. Saved, explicitly confirmed, and queued it while no test worker was running. Opened history and observed queued.
3. Used **All conversations → Communication settings**, checked **Pause new submissions**, and saved. The UI showed paused with one pending message.
4. Ran a test-owned worker pass. It claimed/deferred this job; the message remained queued, attempts stayed **0**, and there was no submission-start event. The browser conversation still showed queued.
5. Returned to settings, cleared pause, saved, and observed enabled with one pending message.
6. Ran a worker pass and inspected the same conversation: submitted. Ran reconciliation, refreshed and expanded processing history: delivered.
7. Verified the same message/job IDs throughout. Final job generation was 3 (paused claim, resumed submission, reconciliation), with only two provider attempts. The earlier unsent draft remained a draft and never acquired a job.

Evidence: [pause enabled](07-pause-enabled.png), [still queued](07-message-stays-queued.png), [resumed submission](07-resumed-submitted.png), [resumed delivery](07-resumed-delivered.png), and corresponding snapshots in [run.json](run.json).

### Test 8 — UX, validation, keyboard and mobile

- Navigation used visible contact/conversation/settings links and browser Back/Forward; saved records reopened without content/identity loss.
- Clicking **Save draft** with required fields blank focused **Subject**, with native message **Please fill out this field**. Filling the fields allowed the same flow to continue.
- Saving returned focus to **Review saved message**. The approval checkbox was keyboard-operable with Space; Tab reached the queue button, and Return activated it. An unchecked checkbox prevented approval.
- The invalid-recipient and paused-sending checks preserved the exact message body; correction/settings changes allowed recovery using the original identity.
- Recipient, server-selected mock sender, purpose and content were presented before approval. History distinguished queued/submitted/delivered, and explicit simulation text remained visible.
- At **375 CSS pixels**, both conversation history and the saved composer had document scroll width **375**, so no horizontal overflow. The composer inspection found **0 unlabeled inputs/selects/textareas**. The desktop measurement was 1280/1280. The viewport was restored afterward.
- The temporary tab’s captured warning/error console list was empty. This is focused keyboard/label/layout verification, not a full assistive-technology certification.
- One minor stale operational-error notice is recorded below. No cosmetic changes were made.

Evidence: [mobile history](08-history-mobile-375.png), [mobile composer](08-composer-mobile-375.png), [invalid-recipient preservation](08-invalid-recipient-preserved.png), and [browser observations](browser-observations.json).

## Defects and future UX findings

### AC-01 — Stale paused-sending error after enabling the workspace

**Severity: P3 / minor; non-blocking.**

Reproduction performed during Test 3:

1. Save an eligible draft in a paused workspace and explicitly attempt approval.
2. Observe **Sending is paused. Open communication settings to enable mock sending**.
3. Navigate to settings, enable sending, save, then reopen the same draft through Conversations.
4. The old paused error remains visible on the reopened draft even though settings are enabled. It clears when the original approval is retried; that retry correctly queues once.

Expected: the operational error is cleared/revalidated on re-entry, or clearly identified as the previous attempt’s result. Observed: the preserved draft also preserves its old error until the next action. The visible/accessibility state was recorded during reopening; [the original paused feedback](03-permission-and-pause-feedback.png) and the later successful queue/submission screenshots document the surrounding flow.

Impact: potentially confusing reassurance after changing settings. No lost content, permission bypass, duplicate message/job, false delivery claim or inability to recover was observed. Leave this for the dedicated UX phase, as requested. No application fix was made during acceptance.

No P0/P1/P2 acceptance defect or new data-isolation concern was observed.

## Focused regression and security checks

Used existing tests rather than rerunning the entire repository:

| Requirement                        | Actual execution/result                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthorized approval/send         | Existing communication consent/authorization scenario rejected Member sending and permission mutation. **PASS**.                                                        |
| Cross-tenant access                | Existing draft/tenant scenario denied foreign conversation history. **PASS**.                                                                                           |
| Duplicate approvals                | Existing concurrent-approval scenario asserted one job and one authorization event for identical requests. **PASS**.                                                    |
| Consent revocation before dispatch | Existing pre-dispatch scenario revoked consent and observed suppression. **PASS**.                                                                                      |
| Destination changes                | Existing changed-destination scenario removed its synthetic CRM email and observed `RECIPIENT_CHANGED` suppression. **PASS**.                                           |
| Phase 03 remains operational       | Existing concurrent replay/conflict/repeat-inquiry/atomic outbox-to-tool vertical slice completed through the restricted worker with correct logical effects. **PASS**. |
| Live provider cannot be enabled    | Existing configuration test rejected unsupported provider mode, `OUTBOUND_LIVE_ENABLED=true`, and malformed signing material. **PASS**.                                 |

Commands executed:

```sh
node --test --test-name-pattern='draft tenant ownership|consent is channel|opt-out, changed|changed CRM destination' tests/communications/database.test.mjs
node --test --test-name-pattern='concurrent replay, conflict, repeat inquiry and atomic outbox-to-tool vertical slice' tests/automation/database.test.mjs
pnpm --filter @leadops/api exec vitest run test/automation.test.ts --testNamePattern='rejects unsupported live modes'
```

Results: **4 communication database scenarios, 1 Phase 03 scenario, and 1 configuration unit scenario passed**. Logs: [security](security.log), [automation](automation.log), and [check summary](checks.json). Before queue-using regressions, existing automation jobs were both completed and acceptance communication jobs were all done. Test fixture teardown was organization-scoped.

No full repository suite, build, reset, migration, dependency upgrade or production/remote test was run for this documentation-only acceptance task. Previous engineering verification is described in [the Phase 04 engineering report](../../../phase-04-report.md); those earlier results are not relabeled as newly executed checks. Its known development-tool/bundle and production-readiness caveats remain outside this client acceptance scope.

## Security, external sending and preservation

- **No real email or SMS was sent.** All business message passes used the deterministic mock adapter. The existing Auth harness delivered only local verification mail to Mailpit for the temporary identity; it did not contact an external mail provider.
- No real provider was configured, and no production environment configuration changed. Mock controls were changed only in the new acceptance workspace, which was subsequently removed.
- Main journeys used actual browser controls. Supplemental database reads were scoped to acceptance-owned records, except pre/post hashes and queue state counts needed to protect existing data. No original customer/organization/contact/lead/automation record was mutated for testing.
- Test-owned worker processes ran one communication pass each and closed their pools. No general worker daemon was started, no original automation job was claimed, and no user-owned process was stopped.
- Original-row hashes were compared across **36 public/private tables**. Every original row remained present and byte-equivalent as JSON. All business table counts returned to baseline. The append-only security ledger grew from **331 to 361** with new test audit events; all original events were preserved.
- Runtime app-session state and the shared mock request counter were excluded from business-row comparison because normal authenticated tests/request reservations change them. Append-only audit and local Auth/session/Mailpit diagnostics follow existing test retention/expiry conventions; no broad audit or inbox purge was attempted.
- All **178 checked source files were unchanged**. The existing API/web PIDs and branch/HEAD were unchanged. No commit, staging, push, merge or deployment occurred.

## Fixture cleanup and retained evidence

After collecting evidence, signed out the test identity, restored the viewport, and closed the temporary tab. Cleanup positively checked the run-specific workspace name/ID, exact synthetic identity, its sole ownership, and both contact names before deletion. Deletion was limited by that recorded organization/user identity; it did not reset/drop/truncate/recreate any database or relation.

Removed the acceptance workspace and identity, two contacts and their channels, three conversations, four message records (three simulated delivered messages and one unsent suppression-test draft), three delivery jobs, 24 lifecycle events, three consent records, workspace controls/budgets and test CRM records. The administrative block had already been removed through the UI. Supplemental regression fixtures were removed by their existing fixture cleanup.

Post-cleanup: original **1 organization, 2 contacts, 2 leads, 2 completed automation jobs** remained. Communication message/job/event/evidence/settings tables returned to their original empty counts. The new fixture organization/user no longer existed. The original application processes remained listening on loopback with the same PIDs.

Retained evidence is intentionally limited to fictional test data, IDs, screenshots, counts and hashes. [run.json](run.json) contains the per-stage durable-state snapshots and all cleanup/preservation checks; no passwords, session cookies, signing keys, database connection strings or provider credentials are included. The temporary fixture helper/state lived outside Git. Evidence IDs below refer to removed fixtures and are not links to current application records.

| Entity                           | ID                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Run workspace                    | `62e671dd-b323-40c5-8c04-5c34db8319d8`                                          |
| Jordan contact                   | `5a022653-3ae2-4d64-97fa-63ce2886694e`                                          |
| Alex contact                     | `14f05e0b-3e5e-410e-84c4-99e917279483`                                          |
| Jordan email message / job       | `255e7f36-40bd-44bb-b604-382408c193cc` / `15392a3b-a9c2-490f-828a-225afb377eac` |
| Jordan SMS message / job         | `e20c5618-a750-48cf-aeb4-e2fb62ce3a4b` / `2a9938ae-c7ba-40f5-9848-9d754efed569` |
| Alex unsent suppression draft    | `78461822-ae4f-4f52-a289-d858341ab32f`                                          |
| Alex pause/resume message / job  | `ebbb88ff-614e-4be2-800b-74b8043563cd` / `ec3183c1-81e2-473d-b655-46376ffce0e4` |
| Jordan email / SMS conversations | `d4c330c8-62e4-4acd-aab2-f7097c1959dd` / `e130bbce-e349-485a-ba29-50bcac5aa55c` |
| Alex email conversation          | `1e4a9db0-1b4a-481f-90d9-21d8b3c56f20`                                          |

## Final merge recommendation

All eight browser acceptance tests and the requested focused security/Phase 03 checks passed. No blocking correctness, safety or tenant-isolation defect was observed. AC-01 is a recoverable notice-state issue suitable for the planned UX refinement phase; the actual sending controls and durable identities behaved correctly. Evidence and cleanup checks are complete, and application code was left unchanged for review.

This recommendation concerns merging the local mock communications foundation. It does not authorize live providers, production deployment or autonomous sending, and does not certify production readiness. Await the user’s review; do not commit or merge automatically.

**READY WITH NON-BLOCKING ISSUES**
