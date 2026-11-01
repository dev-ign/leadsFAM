# Phase 04 manual walkthrough — FreshNest Cleaning

This walkthrough uses **mock delivery only**. No email/SMS provider credentials, subscription or real outbound message are needed. Use fictional contacts and `example.test` destinations. A delivered status in this environment means simulated delivery, never delivery to a customer.

## Start the local application

1. Use the repository's pinned Node 26.13.0 and pnpm 12.16.1. Keep Docker Desktop running with loopback-only bindings as described in `supabase/README.md`.
2. Keep your existing database. **Do not run `db:reset`.** If the Phase 04 migration is already installed, do not reapply its SQL manually. A maintainer can apply pending migrations with the existing guarded local CLI's `migration up --local` path.
3. In a terminal at the repository root, run `pnpm dev`. It builds shared packages and starts the API and web app. Open `http://127.0.0.1:5173`. Use the same host spelling consistently for web/API.
4. In a second terminal, run `pnpm worker:dev`. To inspect queued state deliberately, leave this terminal stopped until the sending step. Starting it never enables real sending.
5. Sign in with your local test account. Choose a test workspace named **FreshNest Cleaning**. Owner/Admin is required for permission evidence, sending and settings; Members can read and prepare drafts. If creating a local account, complete verification through local Mailpit at `http://127.0.0.1:54324`.
6. If existing development processes predate this phase, restart the API launcher and worker so they load the new mock webhook configuration. Do not stop/reset the database. A browser refresh may be needed after shared contracts rebuild.

## Prepare a fictional contact

1. Choose **Contacts → New contact**.
2. Enter display name **Jordan — Synthetic FreshNest Prospect**. Use email **prospect@example.test**. For SMS, add **+12025550123**, country **US**. Save the contact. Use a distinct synthetic contact or explicitly review a duplicate if the address already exists.
3. On the contact, find **Communications**. **View message history** opens this contact's conversations; **Compose message** prepares a new draft. The lead detail page has equivalent links, with the lead association retained.

## Inspect settings and enable mock sending

1. Open **Conversations → Communication settings**. Conversations is in both the main navigation and workspace links.
2. Confirm **mock providers**, **live sending unavailable**, and **Mock sending: paused** for a new workspace. The displayed sender is a simulation identity, not your business's verified sender.
3. Review the defaults: 100 workspace messages/day, 5 per destination/day, 100 per channel/day, 2 simultaneous submissions, 30 workspace requests/minute, 3 processing attempts. Windows use UTC days and fixed minutes. A shared mock-provider cap is 60 requests/minute. Admission counts include failed reservations; retries use request budgets.
4. Clear **Pause new submissions** and click **Save sending controls**. Status changes to enabled. No provider secret is shown or requested.
5. Return to the contact and choose **Compose message**.

## Save and approve an email draft

1. Choose **Email**, recipient **prospect@example.test**, purpose **Service or transactional**.
2. Enter subject **Your FreshNest appointment** and message **Hello Jordan! Your synthetic cleaning appointment details are ready. This is a mock test.**
3. Click **Save draft**. The review heading receives focus. A saved draft is durable; reopening **Conversations → the contact's email conversation → Open draft** preserves its content. The channel is fixed after saving; **Start another draft** creates a new identity for another channel.
4. Before evidence exists, sending is blocked with an explicit-permission explanation. Being in the CRM is not consent.
5. Expand **Record permission evidence**. For this fictional test only, enter:
   - Consent source: **Synthetic FreshNest service request**.
   - Collected at: a date/time in the past, using your local time.
   - Recipient country code: **US**.
   - Disclosure or policy version: **synthetic-service-v1**.
   - Evidence reference: **synthetic-manual-fixture-only**.
6. Click **Record explicit permission**. Expect **Eligible under the explicit-permission mock policy**. This conservative development policy is not legal approval for real outreach.
7. Check **I reviewed this exact saved message, its recipient and purpose, and authorize mock sending**. Click **Confirm and queue mock message**. Expect **Message queued for mock delivery**, with no claim of external delivery.
8. Open **View delivery status and history**. With the worker stopped, status remains queued. Start `pnpm worker:dev`; use **Refresh status** to observe processing. Provider acceptance appears as **submitted**, followed by **delivered** in a subsequent reconciliation pass. The second pass is normally due two seconds later, so you may see the final result first if refreshing slowly.
9. Expand **Processing history** to inspect draft creation/update, send request, authorization, queue, submission start, provider acceptance and simulated delivery. Long histories have **Next events**. Message histories use **Next messages**; conversation lists use **Older conversations**. No background frontend polling is required.
10. Click **Contact record → View message history**. The same conversation and delivery result appear; content is not copied into CRM activities. Lead-linked messages also link back to their lead.

## SMS, marketing, failures and blocked destinations

- **SMS:** start another draft before the first save, choose SMS, and select the international number. There is no subject; content is limited to 1600 characters. Record separate SMS/service evidence, save, confirm and queue. Email permission does not grant SMS permission.
- **Marketing:** selecting Marketing requires its own explicit evidence. Service consent never automatically authorizes marketing.
- **Invalid destination:** enter a syntactically valid address absent from the contact, save, and observe **destination is not on this contact**. Sending remains blocked. Correct the recipient and save again; content is preserved. Malformed emails/phone numbers are rejected before persistence. Add/correct the destination on the CRM contact when needed.
- **Administrative block:** choose **Block this destination**. Eligibility becomes blocked even if evidence remains granted. **Remove administrative block** removes only administrative blocks. This does not create consent.
- **Opt-out:** use the evidence form's **Record opt-out** with its supporting evidence. Sending stays blocked, including queued messages not yet admitted. New consent alone does not erase suppression. Provider opt-outs and bounces cannot be cleared by the administrative-block toggle. START does not grant permission.
- **Mock terminal failures:** create a separate synthetic contact with **fail@example.test** or **bounce@example.test**, record its own evidence, and send. The mock adapter accepts first; reconciliation then reports failed or bounced. A bounce also suppresses that destination. These reserved mock outcomes do not call a provider.
- **Pause:** stop the worker, approve a message, then enable **Pause new submissions** in settings. Start the worker. The message stays queued. Unpause to resume. An operation already admitted before a pause may finish; accepted messages still reconcile while paused.
- **Attention:** unknown submission outcomes are never blindly resent. An administrator can open the message and choose **Check delivery status safely**. This schedules reconciliation only. If a real provider cannot prove an outcome in a future integration, investigation must precede creating a replacement message.
- **Uncertain save/send response:** retain the same draft ID and approval version. Retry the same request or inspect the conversation first; do not create a new message merely because a response timed out.

## Signed mock webhook and reliability checks

The worker simulates asynchronous delivery without needing a public webhook server. The separate mock webhook endpoint is `/webhooks/mock/communications`, only in non-production with an isolated server signing key. The local API launcher provisions it outside the repository. It verifies HMAC-SHA256 over `timestamp + '.' + exact raw body`, with five-minute freshness. No unsigned bypass exists. Do not paste signing keys into the browser.

Use the automated synthetic harness for exact-byte signatures, stale/forged events, duplicate events, STOP/unsubscribe, START, cross-tenant IDs, worker process death, leases, timeout, atomic rollback and budgets:

```sh
pnpm test:communications
node tests/database/phase-04-migration.mjs
node tests/performance/communications.mjs
```

The crash test kills only its own synthetic subprocess and advances only its fixture's lease time. All test/benchmark fixtures are cleaned up by their organization IDs. The migration rehearsal uses an isolated transactional namespace and rolls it back. None of these commands resets the database or sends externally.

## Boundaries

No scheduling, quiet hours, autonomous sending, campaigns, AI, real-provider credentials, general inbound inbox or content-retention administration is enabled. The database retains business history and idempotency identities; retention/deletion, legal policy coverage, tenant-owned credentials and real-provider signatures require separate implementation and review before live use. Local verification is not production certification.
