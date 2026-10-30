# ADR 0001: A small modular monorepo

Status: accepted in the Phase 00 plan. Date: October 29, 2026.

Context: the product needs a browser UI, API, and eventual asynchronous/AI capabilities, but initially has one team and no business data.

Decision: use pnpm workspaces and Turborepo with web/API applications and UI/shared/config packages. Applications depend inward on shared packages. Local dependencies use `workspace:*`; exported package entry points are built before consumers. Enforce the graph and cycles in lint.

Consequences: contracts can change atomically across the API and browser, tooling stays consistent, and builds remain understandable. Package exports require an initial build, handled by root tasks. A monorepo does not require one deployment. Workers/database/agents/integrations/observability remain documented future responsibilities instead of empty packages. Microservices and a general workflow framework would add failure modes before a demonstrated need.
