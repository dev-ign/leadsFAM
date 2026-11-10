# Phase 08 synthetic conversation walkthrough

Use the preserved loopback development stack and isolated fictional accounts/workspaces. No real provider, paid AI or actual customer communication is needed. Follow the existing [Phase 07 ingress preparation](phase-07-manual.md); never reset preserved development data.

## Developer preparation

1. Use Node 26.13.0 and pnpm 12.16.1. Build the affected packages, start the verified local stack with existing tooling and apply the reviewed additive migration without reset. Start the local API/web with real AI disabled. Keep the general worker stopped while preparing controlled fixtures.
2. Create two synthetic owners/workspaces, FreshNest and Bluebird. In FreshNest, create Michael Rivera (synthetic), an example.test address and two distinct leads. Keep the original inquiry/status available for preservation checks.
3. Save enabled **simulation** AI settings with fictional approved service `Deep cleaning` and area `Exampletown`. The walkthrough used generic missing scope/timeframe categories. Existing unknown-fit, required-business-answer, restriction and escalation rules can correctly produce Human Attention; they are not relaxed for orchestration.
4. Create an inbound-only mock integration. Prepare a synthetic outbound thread through the existing human draft/approval/mock path so a signed reply can reference its submitted/delivered message. Record explicit fictional permission for any proposed outbound destination; receiving a reply does not grant permission.
5. Use the existing `scripts/mock-inbound.mjs` with a synthetic event file outside Git. Its signing root/key stays server-side. Run only controlled worker passes for the intended synthetic requests/jobs; verify claimed identity/workspace before processing. Do not process unrelated preserved work.

Example incoming content: “Hi, I need Deep cleaning for a 3-bedroom apartment in Exampletown next Friday. Do you have availability?” Keep a stable event ID for replay and a verified outbound `replyTo` when there are multiple leads.

## Owner acceptance

1. Sign in to FreshNest, open Conversations and the customer's email thread. Verify Incoming / Received, exact normalized text, connector and server receipt time. Before clicking Evaluate, verify no AI request or recommendation exists.
2. Click **Evaluate latest reply (simulation)**. Observe durable Evaluating state. After the developer runs the existing AI worker, inspect **Suggested next action** and its simulation label. Expand explanation/evidence/proposed wording. Unknown scope/timeframe remain unknown; no availability or price is invented.
3. Choose **Prepare follow-up draft**. Inspect the confirmation: it accepts this exact recommendation and prepares an unapproved message to the reply's saved customer address. Keyboard focus enters the confirmation. Cancel returns to preparation; Enter confirms. Missing consent, suppression or a changed destination must block preparation without accepting/completing it.
4. Open the saved message. Confirm it is a draft with no send job. Edit the wording, keyboard-save it, inspect the exact persisted recipient/purpose/content, then separately check the existing approval checkbox and queue mock sending. The developer processes only that mock job. Verify mock-delivered history and the exact human edits.
5. Replay the original signed event. Receipt/message IDs, recommendation count, AI request count and draft count must not increase from receipt replay.
6. Receive another fictional reply and explicitly evaluate it, leaving its review open. Receive a correction before confirming preparation. The stale action must be denied, with an understandable focused error and no second draft/job. Refresh/evaluate intentionally rather than applying the old suggestion.
7. Evaluate the correction. Verify **Business owner attention needed**, attributed evidence and no Prepare control. Accepting this recommendation only acknowledges it; it does not create a message or notify anyone.
8. Receive an ambiguous message without a trustworthy reference while Michael has two leads. It stays in Phase 07 Needs Review and creates no AI request. Select the saved customer and compatible apartment lead, review and explicitly link. An already-open recommendation from before linking must be stale. Even an old linked receipt outside the six-message AI window invalidates prior review through the conversation revision (database-tested).
9. Intentionally evaluate after linking. Verify bounded context includes the linked reply when recent. Defer means later human review with nothing scheduled. Dismiss records the decision without a message. Inspect recent suggestion history and review timestamps.
10. Test keyboard focus, loading/recoverable errors and supported mobile widths. Long message text should wrap. This is focused acceptance, not screen-reader certification or production capacity validation.
11. Sign in as Bluebird's owner. Only Bluebird is listed. FreshNest's conversation URL must show unavailable without customer/recommendation content. Automated HTTP tests additionally prove foreign review mutations are denied.
12. Remove only the identified synthetic fixtures, verify retained business hashes/counts and stop test servers/Supabase with volumes preserved. Do not reset the database.

## Actual execution

The steps above were completed November 10, 2026. Four signed incoming receipts and four intentional simulation evaluations were used. One reviewed recommendation created one unapproved draft, subsequently human-edited, separately approved and mock-delivered. Replaying the initial event kept the same receipt/message and left counts unchanged. Two stale open reviews were denied; the discovered error-focus gap was corrected and verified in a focused UI case and actual browser. A later Human Attention recommendation was deferred then dismissed, without scheduling or sending. The final worker context contained exactly six messages, including the manually linked reply. Bluebird could not open FreshNest's conversation.

Actual measured widths were 390 and 702 CSS pixels, with document width equal to viewport and wrapping paragraphs. The viewport override was reset. An intentional turn interruption terminated the fixture controller before its final evidence write; persisted outcomes and recorded tool observations were reconciled before scoped cleanup. Both synthetic accounts/workspaces were removed, twelve retained business-table hashes matched the pre-migration baseline and development ports were stopped.

See the [report](phase-08-report.md), [UI observations](benchmarks/phase-08/browser-ui.json) and [reconciled outcomes](benchmarks/phase-08/browser-acceptance.json). Phase 06 live application smoke, live-model evaluation, privacy, human usefulness and spend acceptance remain open.
