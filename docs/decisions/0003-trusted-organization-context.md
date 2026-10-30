# ADR 0003: Backend-owned organization context

Status: implemented for organization operations in Phase 01; worker/agent portions remain design only. Date: October 29, 2026.

Decision: distinguish identity verification, permission checks, and row isolation. All tenant-owned operations must receive organization context derived by trusted backend code from verified identity plus current organization membership and operation permission. Never deserialize authorization from a browser, a model output, or an unchecked job payload.

Use organization-scoped services/repositories, RLS/grants where applicable, tenant-aware relationship constraints, and independent application/database negative tests. Workers bind a trusted job's organization and capabilities explicitly. Model tools capture that same context outside model-controlled arguments.

Consequences: a user can belong to multiple organizations without a global "current tenant" variable. Switching the selected organization requests a new authorization decision. Privileged worker credentials cannot be used as permission to ignore scope. API filtering and RLS reinforce one another. Phase 01 ships an OrganizationContext only with the database-backed membership resolver and repeated operation checks.
