# LeadsFam working roadmap

Planning decision: November 9, 2026 (America/New_York). The product owner selected the November 4 proposal in [Phase 06 Review](https://chatgpt.com/c/6aea0087-8a6c-83ea-8e51-1fe67bb6508f) as the working development direction. This document records that decision; it does not authorize production deployment, live AI, real provider connections or autonomous messaging. Detailed future acceptance criteria require a phase implementation specification.

## Implemented foundations

- Phases 01–02: identity/workspace security and CRM foundations, including contacts, leads, imports and authorization.
- Phase 03: tenant-bound first-party lead intake, durable/idempotent execution, versioned workflows and guided automation setup.
- Phase 04: persistent communications, human editing and exact-version approval, consent/suppression controls and mock-only delivery.
- Phase 05: bounded AI execution/provider boundary, durable requests/attempts, quotas and disabled-by-default real inference.
- Phase 06: locally implemented versioned business knowledge, grounded lead qualification, bounded conversation context, reviewed proposals and evaluations. Local implementation and synthetic tests are not live-model or customer-rollout acceptance. See the [engineering report](phases/phase-06-report.md) for actual verification and the final durability correction.

No real inbound connector, live communication delivery or live-model usefulness has been accepted. The existing conversation context was exercised with synthetic messages. Human approval and mock-only sending remain required.

## Selected future direction

| Phase | Title                                                         | Planning objective                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 07    | Inbound Communications and Conversation Management Foundation | Verified mock inbound email/SMS events, contact matching, durable ingestion, replay protection, conversation threading and correct lead attribution. Develop locally without real-provider credentials.                   |
| 08    | Conversation Orchestration                                    | Connect received replies to analysis and follow-up workflows; handle missing information, corrections, escalation, cancellation and duplicate events while preserving approval boundaries.                                |
| 09    | Operational Safety and Observability                          | Extend audit trails, tenant quotas, failure diagnostics, cost accounting/visibility, operator controls and realistic multi-tenant load verification. Extend existing tooling before introducing infrastructure.           |
| 10    | Real Integrations and AI Acceptance                           | Configure approved provider accounts, benchmark models, validate provider-specific signed inbound webhooks, test separately authorized controlled outbound delivery and close outstanding Phase 06 live acceptance gates. |

The [November 9 closure review](phases/benchmarks/phase-06/closure-review-2026-11-09.md) contains a proposed minimal Phase 07 implementation sequence. Its engineering scenarios are proposals, not original formal acceptance criteria. The current durability assignment does **not** implement Phase 07.

## Open Phase 06 acceptance gates

- A controlled synthetic live request through the application, with durable reported provider/model/usage metadata.
- Live-model evaluation and empirical model selection against unchanged quality thresholds. Acceptance must invoke `--enforce-thresholds`; exploratory simulation is explicitly non-acceptance and remains below quality thresholds.
- Provider/privacy review covering processing terms, retention, geography and data minimization.
- Human usefulness assessment using the existing rubric.
- Approved spend controls, model-specific pricing and reconciliation of uncertain usage. Quotas and estimates alone are not a hard monetary ceiling.

These gates remain outstanding during local mock development. Moving their operational work later does not waive them. Real credentials, customer data processing, provider connections, any change to human approval, real sending and production deployment require future explicit authorization and applicable acceptance evidence. No new framework, model provider, queue, vector store, microservice or custom accounting subsystem is selected by this roadmap.

## Superseded proposal, retained for history

[Review Phase 05 Readiness](https://chatgpt.com/c/6ae7e87d-67f8-83e9-9273-d8a38a8eacfd), November 2, proposed Phase 07 **Real-world integrations**, Phase 08 **Advanced agent automation**, Phase 09 **Production readiness**, and Phase 10 **Premium UI/UX and design system**. It explicitly identified itself as an uncommitted proposal. The product owner's November 9 selection supersedes that sequence for planning; the original proposal remains preserved in its source conversation and the closure review.
