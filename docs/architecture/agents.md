# Agent architecture: reasoning within authorized boundaries

Phase 00 documents this boundary. There are **no installed OpenAI SDKs, executable agents, agent tools, provider credentials, or model calls**.

## Terms that belong to different layers

An **LLM** generates text or structured predictions. An **agent** combines a model with instructions, available tools, and an execution loop. A **tool** is application code exposed through a constrained interface. A **handoff** transfers reasoning responsibility to another specialist; it must not expand that run's permissions. A **durable workflow** persists progress and recovers execution after crashes, retries, and pauses.

The planned OpenAI Agents SDK handles reasoning and tool coordination inside our runtime. Our application still owns authorization, tools, storage, approval decisions, and operational policy. See the [official SDK documentation](https://developers.openai.com/api/docs/guides/agents/sdk). A successful agent loop does not make a side effect durable or exactly-once.

Example: a conversation agent might propose a follow-up message. An application policy checks organization scope, recipient consent, opt-out state, channel permission, budget, and any required human approval. A durable workflow records an idempotent send intent and reconciles provider results. A crash between provider acceptance and local recording must not blindly trigger a second send. None of that send path exists yet.

## Planned runtime boundary

Each execution will refer to an immutable/versioned agent definition and policy version, a trusted actor/job and organization context, validated structured input/output schemas, approved tool names, a deadline, step/token/cost budgets, and audit correlation. Organization-specific instructions are scoped configuration; they cannot grant new permissions.

A tool registry will bind narrow handlers to backend-owned organization context. Arguments from the model may identify a permitted resource or proposed action; they cannot select an effective organization or credential. Each handler validates arguments, authorization, resource ownership, consent, approval state and policy before an external effect. Approval must bind to the specific action/recipient/payload/version, not a general earlier conversation.

Provider keys remain server-side. Agents get no unrestricted database client, shell, credentials, arbitrary HTTP, or arbitrary MCP registration. Retrieved documents, webhooks, customer messages, and tool outputs are untrusted data, even if they contain instructions or apparent approval text. Tool allowlists and deterministic policy are the security boundary; prompt wording and model guardrails supplement them.

## Planned execution and evaluation controls

- Version definitions, schemas, prompts, tool policies, and evaluation datasets.
- Validate structured outputs independently of their model origin.
- Enforce deadlines and budgets outside the model; reconcile actual usage and cancel safely.
- Define retryable failures explicitly. Retry reasoning separately from idempotent side effects.
- Persist approval pauses and workflow state in a durable system selected when needed.
- Record safe audit events for requested/approved/executed/failed actions with tenant correlation.
- Minimize and redact tracing content; decide retention, access controls and provider export policy before tracing customer messages.
- Evaluate prompt injection, cross-tenant requests, forged approvals, unsupported tools, duplicate actions, consent changes, and budget exhaustion.

Future specialists may cover discovery, enrichment, qualification, conversation, outreach, scheduling, and coordination. Start with one bounded, evaluated use case after authentication and tenant isolation are verified; seven empty agent definitions would add no assurance.
