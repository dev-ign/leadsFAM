# Phase 07 synthetic customer-reply walkthrough

Use only the preserved local development environment and fictional customer data. Real provider accounts and AI credentials are not needed. Inbound signing credentials remain on the server; do not paste them into the UI, logs or this guide.

## Developer preparation

1. Build the affected packages, start the loopback Supabase stack using existing tooling, and apply the additive Phase 07 migration without resetting development data. Start the local web/API. Keep the general development worker stopped during controlled fixture testing.
2. Use two isolated synthetic users/workspaces, such as FreshNest and Bluebird. Create Michael Rivera (synthetic), a saved example.test email/international test number and two separate leads. Use explicit synthetic permission evidence for any mock outbound fixture.
3. In Integrations, choose **Simulated customer replies**. This purpose is separate from **New lead inquiries**. Inbound create/rotation does not reveal a key. The local server uses its existing mock root; ask the developer to configure it if the test integration is unavailable.
4. Prepare a fictional email/SMS event file outside the repository with restrictive local permissions. Use an event ID once for a logical message; retain exactly the same normalized details when retrying.

```json
{
  "eventId": "synthetic-reply-1",
  "channel": "email",
  "sender": "michael@example.test",
  "subject": "Re: Cleaning inquiry",
  "body": "Actually, I need a deep cleaning for a 3-bedroom apartment next Friday. Can you provide an estimate?",
  "replyTo": null,
  "occurredAt": null
}
```

For a verified reply, `replyTo` is the existing submitted/delivered outbound message UUID. Without it, ambiguous customer/lead relationships require review. SMS uses an international test sender, empty subject and at most 1,600 characters.

The developer-only local transport command is:

```sh
node scripts/mock-inbound.mjs <synthetic-event.json> <integration-id> <credential-generation>
```

The public connector ID/generation come from the authorized integration record. The tool resolves local configuration and signs the exact bytes; it prints only the typed receipt outcome. It is not a live provider connector or a public website-form credential flow.

## Business-owner checks

1. Open the saved email draft, edit it, save it with the keyboard, inspect the persisted content/recipient and separately approve its exact version. Do the same approval step for a saved SMS. The developer can process the corresponding jobs through the existing mock adapter. Observe **delivered**, not a claim of real delivery.
2. Receive a signed email reply referencing the sent email. Open Conversations, then the customer's email thread. Verify **Incoming email · Received**, the customer's text, server receipt time and simulated connector label.
3. Replay the same event. Refresh history and confirm one message. A changed payload under the same event ID must be a conflict, not an edit.
4. Receive a signed SMS reply and verify the same behavior in the SMS conversation.
5. Receive a reply without a trustworthy reference where Michael has two legitimate leads. Under **Incoming replies · Needs review**, inspect **Multiple possible conversations**. Open **Review reply**; focus should move to its heading. Select the existing customer and the compatible apartment lead, review the association and confirm it explicitly.
6. Verify the success message receives keyboard focus and its conversation link works. The incoming message keeps its original receipt time even though linking happened later. No contact/lead is created or merged, and lead status, consent and outbound jobs do not change.
7. From the lead record, intentionally click **Analyze lead**. Run only the corresponding synthetic worker request. Inspect the simulation label, quoted conversation evidence and human-review/unknown fields. Inbound receipt/linking alone must not create an AI request or response draft.
8. Sign out and use Bluebird's separate user. FreshNest's lead and conversation URLs must show unavailable, and Bluebird should list only its own workspace. API tests additionally verify foreign linking is denied.
9. Check long text at supported mobile/desktop widths, recoverable loading/errors and keyboard operation. This walkthrough is not screen-reader certification or production performance testing.
10. Remove only the isolated synthetic fixtures, stop web/API/test processes and stop Supabase with volumes preserved. Do not reset the database.

## Actual execution

The walkthrough above was completed November 9, 2026. A second ambiguous reply verified the success-focus correction. Four unique incoming receipts/messages existed before manual reanalysis; received-event replay kept the original message ID. AI request count remained zero until the separate Analyze action, then became one. No pending outbound job was created by incoming events. Both outgoing messages were approved separately and mock-delivered. Fixture cleanup completed and local service ports were stopped.

See the [engineering report](phase-07-report.md), [UI observations](benchmarks/phase-07/browser-ui.json) and [operation evidence](benchmarks/phase-07/browser-acceptance.json). Phase 06 live evaluation, privacy review, human usefulness and spend acceptance remain open.
