# Phase 06 architecture and security

Phase 06 extends the Phase 05 modular monolith, provider interface, durable queue, authenticated RPCs and Phase 04 communications. It adds no dependency, provider SDK, vector service, embedding pipeline, broker or general agent tools.

## Contracts and context

`lead-assist-v2` / analysis v2 adds intent category (`service_inquiry`, `pricing`, `scheduling`, `complaint`, `other`, `unknown`), service/area fit (`supported`, `unsupported`, `unknown`), approved service index, urgency, quoted budget, required-information answers, conflict flag and human-review requirement. Original evidence, missing categories, status, priority and next action remain. These are recommendations; CRM data does not change. Explicit nulls and unknown values are valid.

Historical v1 records remain readable without rewriting them. New preparation records v2. Result grounding retains the settings version, inquiry timestamp, selected approved facts, unresolved business requirements and included message IDs. Editing settings increments the existing version. Source fingerprints include knowledge version and current selected conversation. A change during inference discards the result with `STALE_INPUT` while retaining supplied usage.

The existing private settings JSON is the single business-knowledge source. It contains bounded service descriptions, FAQ question/approved-answer pairs, pricing/estimate policy, scheduling policy, hours, required information and unsupported requests. Existing services, locations, questions, tone, restrictions and escalation are reused. The API uses strict Zod validation; ordinary database RPC callers also receive nested key/type/size/reference validation. The complete business object has a 16,000-byte database ceiling. No raw schema/model settings appear in the owner form.

A tenant/contact/lead-scoped SQL query selects the latest six delivered messages and returns them chronologically, with stable ID ordering for equal timestamps. Each body is limited to 600 characters. Unsent drafts, other contacts, other leads and unrelated conversations are excluded. Outbound messages provide conversational context only; they cannot support customer facts. Customer evidence may quote lead fields or a selected inbound message, and the server checks both attribution and exact quote inclusion. Conversation timestamps and the inquiry timestamp accompany original relative wording; the system does not invent calendar dates. Very long histories/bodies are deliberately truncated; this is bounded recent context, not complete memory. No inbound ingestion product is introduced: future connectors must authenticate inbound authorship before populating the existing message store.

The small structured knowledge set is loaded relationally in the same source read. Model-selected knowledge references are checked against that exact version; invalid indexes and missing policies fail closed. There is no demonstrated need for semantic retrieval.

## Provider and execution

The existing Responses API call uses a fixed HTTPS endpoint, redirects denied, separated system instructions/user JSON, strict JSON Schema, `store:false`, no tools, bounded response streaming and server-only credentials. The provider receives task/channel/purpose along with context. Refusals, incomplete output, tool calls, invalid schemas and fabricated evidence are rejected. Returned model identity replaces the requested alias when reported. Usage is recorded only when supplied. No simulated token counts are created.

Real inference still needs **both** workspace real mode/enablement and worker `AI_REAL_ENABLED=true`, explicit `AI_MODEL`, `AI_API_KEY`, and `AI_DATA_HANDLING_ACK=reviewed`. Missing configuration never falls back to simulation. Defaults: 24,000 source JSON bytes, 2,400 output tokens, 32,000 response bytes, 15 seconds. Configurable deadline maximum is 20 seconds, below the existing 45-second lease; input/output ceilings remain bounded. Fixed prompt/schema overhead is additional to the source byte ceiling. Token usage and latency need live measurement.

Calls remain outside database transactions. Existing current-membership/publisher/integration checks, source revalidation, per-tenant concurrency, daily/queue admission, fencing, cancellation and attempt records remain. Explicit 429 retries are bounded; uncertain network/timeouts/crashes are never blindly repeated for real inference. Simulation recovery retains the three-attempt ceiling. Prepared-context validation is inside the worker failure boundary: a malformed envelope is durably failed through the existing fenced finish operation before provider execution, rather than being left claimed until expiry. An already-revoked preparation is not finished twice.

Roll out by quiescing old workers, applying the additive migration, building and starting the matching worker/API/shared contract, then validating synthetic requests. An old process cannot understand new context fields; it can leave simulation leases to recover. Do not run mixed worker versions or migrate an active real-inference queue. No rollout was performed outside local development.

## Draft grounding and authorization

The model chooses missing question categories, relevant approved business-question indexes and approved knowledge references in one inference. The server composes a concise proposal from safe application wording and exact approved facts/questions, using contact name, channel, tone and purpose. Generic scope questions are suppressed when specific business questions are available. Unsupported fit, unsafe input and conflicts use a handoff. SMS includes fewer facts/questions; oversized proposals fail validation rather than silently changing content.

This is intentionally constrained composition, not unrestricted model-written prose. An arbitrary provider body is rejected by the strict response schema; customer excerpts never become outbound message text. Owner-authored facts are still reviewable and can be wrong or inconsistent. Basic instruction/URL/credential patterns are denied in emitted knowledge; these patterns are supplementary safeguards, not a complete prompt-injection classifier. Exact quote checks establish provenance, not semantic truth. Recommendations remain unverified and all proposals require human review.

The provider has no recipient, consent, tenant, actor, approval or sending fields and no tools. Saving requires a current authenticated human, a destination already belonging to this lead's contact, and the unchanged Phase 04 save boundary. Human edits are the final draft. Separate administrator authorization applies to its exact saved version with consent/suppression checks and mock-only delivery. No AI operation sends a message or grants communication permission.

## Database security

One additive migration extends constraints/defaults/functions and adds a query-specific conversation index. No existing rows are rewritten. The existing NOLOGIN, NOSUPERUSER, NOBYPASSRLS AI owner gains scoped SELECT only on the existing message table. Its RLS policy uses the transaction-local organization set by already-authorized entry points. Authenticated/runtime/worker roles still have no direct access to private message/AI tables. Worker RPC capabilities and human-only draft-save privileges are unchanged. The new knowledge validator is private and not granted to API roles. Temporary schema CREATE for ownership transfer is revoked in the same migration. Public RPC signatures and generated database types are unchanged.

## Cost, privacy and rollout

Estimates use actual provider token counts multiplied by explicit, versioned input/output prices, rounded up to micro-USD. Without usage or pricing, cost remains unavailable. Cached-token discounts are not assumed; the estimate can conservatively overstate discounted usage. Prices must match the configured model, region and contract. Workspace request counts, bounded attempts/tokens, queue size and concurrency provide the initial synthetic rollout controls; a monetary ledger/reservation system is deferred until pricing/usage reconciliation is validated. Use low request limits and provider-project spend controls for initial tests. Uncertain usage requires operator reconciliation before re-execution.

`store:false` is not a zero-retention or residency guarantee. Review organization/project access, DPA/contract, retention eligibility, regional processing, data minimization and incident policy before customer data. The current fixed endpoint must be reviewed against required geography; this change does not implement regional routing. Business-result retention/deletion policies remain an operational prerequisite.

Official documentation reviewed November 2, 2026:

- [Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
- [GPT-5.4 Mini support, snapshot and pricing](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
- [GPT-5.6 Terra support and pricing](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [Provider data controls](https://developers.openai.com/api/docs/guides/your-data)
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase changelog](https://supabase.com/changelog) (markdown endpoint could not be fetched; HTML was inspected). No relevant RLS API change required a dependency upgrade.

## Evaluation execution

The fixed synthetic runner prevalidates all cases, preserves failed cases in every applicable metric denominator and records raw provider injection judgment separately from enforced application review. Missing observations fail the aggregate gate. A bounded deadline covers providers that ignore cancellation. Supplied failure usage is retained; arbitrary exception messages are excluded. Reports carry an evaluator version and timestamp. `--enforce-thresholds` yields exit status 2 on simulation quality failures; live evaluation enforces those gates automatically. Passing automated metrics alone never approves a model or rollout: durable synthetic application validation, security evidence and human usefulness review remain separate requirements.
