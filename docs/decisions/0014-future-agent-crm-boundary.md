# ADR 0014: Provider-independent CRM tools, deferred execution

Phase 02 implements domain services and transactional database guarantees, not an agent runtime. Future OpenAI Agents SDK adoption belongs in an adapter around these services and is intentionally absent from CRM/shared/database dependencies.

A tool will receive backend-bound actor/job, organization, policy version, correlation and deadline. Model arguments may propose bounded resource fields and expected versions, never effective tenant, system actor or credentials. The handler must reauthorize before read/write, validate typed output, preserve idempotency and require human approval bound to the exact action when appropriate. Handoffs retain the run's existing scope and cannot grant more authority.

Untrusted lead/CSV/reference content is input data. Deterministic permissions, consent, approval and budget checks live outside model reasoning. AI inferences remain distinct from verified facts. Tracing must minimize PII and have a separate retention/export policy. Outbound actions require durable intent/reconciliation, not fire-and-forget model calls.

This creates no SDK dependency, tool registry, worker, integration, model call or executable agent. See [the agent boundary](../architecture/agents.md) and [CRM contracts](../architecture/crm.md). Phase 03 needs separate approval.
