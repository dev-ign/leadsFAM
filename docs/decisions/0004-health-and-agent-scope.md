> Historical Phase 00 decision. Phase 01 adds supported Supabase Auth, sessions and tenant persistence; `/health` keeps its narrow liveness meaning. The agent/worker restrictions below remain in force.

# ADR 0004: One observable vertical slice; deferred execution systems

Status: accepted. Date: October 29, 2026.

Decision: Phase 00 implements only a health request from browser presentation through one typed API client to Fastify and back through runtime validation. The client centralizes origin, timeout/cancellation, credentials policy, safe errors, and contract parsing. Feature code consumes the client rather than fetch. `/health` checks reachability; `/ready` is deferred until runtime dependencies make readiness meaningful.

No Supabase/OpenAI runtime dependencies, login simulation, tenant data, worker, or agent framework are installed. Document the future agent runtime with explicit authorized tools, validated structured data, approvals, budgets and tracing/evaluation policy. Select durable workflow infrastructure later; the Agents SDK will not be used as an implicit persistent retry engine.

Consequences: a new engineer can run and test without credentials or external services, and the dashboard never pretends setup placeholders are real metrics. Production authentication/session storage, tenancy enforcement, retries and external side effects remain explicit future work. This foundation is useful and verifiable without claiming business functionality or production readiness.
