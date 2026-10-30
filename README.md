# LeadOps AI

An industry-agnostic lead acquisition and engagement platform. **Phase 00 is a foundation preview, not a production application.** There is no authentication, tenant persistence, agent execution, or business data. Mirembe Cleaning is a future customer, not a hardcoded product identity.

## Local setup

Prerequisites: Git and nvm (or an equivalent Node version manager). Node **26.13.0 LTS** is pinned in `.nvmrc`; pnpm **12.16.1** is pinned in `packageManager` and package engines. These versions were verified against the official Node release index and npm metadata on October 29, 2026. See [dependency decisions](docs/decisions/0002-runtime-and-dependencies.md).

```sh
nvm install
nvm use
npm install --global --allow-scripts=pnpm pnpm@12.16.1
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173>. The API listens at <http://127.0.0.1:3001/health>. No environment files, cloud accounts, API keys, Docker, or database are required. The API's optional `.env` loader prints an informational notice when no file exists.

Optional customization:

```sh
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
```

The root `.env.example` explains ownership; the root `.env` is not loaded. Restart the relevant development process after configuration changes. `VITE_*` variables are public build-time values. Never put a secret in them. Production API configuration requires explicit HTTPS CORS origins. HTTPS termination and browser asset security headers require a future deployment decision.

## Commands

| Command                             | Purpose                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm dev`                          | Build shared packages, then watch web, API, UI, and contracts                              |
| `pnpm build`                        | Produce all application and library artifacts                                              |
| `pnpm typecheck`                    | Check source, tests, and library declarations                                              |
| `pnpm lint`                         | Enforce ESLint, package boundaries, and module/package acyclicity                          |
| `pnpm test`                         | Run boundary regression tests and all Vitest suites                                        |
| `pnpm format` / `pnpm format:check` | Write / check formatting                                                                   |
| `pnpm verify`                       | Format check, lint, typecheck, tests, and builds                                           |
| `pnpm audit:dependencies`           | Audit all dependencies; high/critical findings fail                                        |
| `pnpm scan:secrets`                 | Checksum-verified Gitleaks working-tree and available-history scans, plus detection canary |

`pnpm --filter @leadops/api start` runs the built API after `pnpm build`. `pnpm --filter @leadops/web preview` serves the built SPA locally. For a working built-web preview, start the API with `NODE_ENV=development CORS_ORIGINS=http://127.0.0.1:4173 pnpm --filter @leadops/api start` (stop another API on port 3001 first). Neither command is a production deployment. API integration tests use Fastify injection without binding a socket.

Root task ordering builds shared exports before checks that consume them. Remote Turborepo caching is not configured. Turborepo may report its default anonymous telemetry notice; set `TURBO_TELEMETRY_DISABLED=1` to opt out (CI does). Do not store secrets in task outputs.

## Repository map

- `apps/web`: composed React presentation, routing, health feature, and one HTTP client.
- `apps/api`: Fastify transport, validated startup settings, safe logging, health contract.
- `packages/ui`: accessible Button composition, Card primitives, semantic theme tokens.
- `packages/shared`: browser-safe Zod wire contracts; no database clients or secrets.
- `packages/config`: strict TypeScript and flat ESLint configuration; shared Prettier settings live at the root.
- `scripts`: boundary enforcement and verified secret scanning.
- `supabase/README.md`: future migration policy; no schema or project exists yet.
- `docs`: architecture, decisions, threats, learning guide, and phase reports.

## Security and scope

The API exposes only health plus the CORS preflight transport route (and Fastify's normal HEAD behavior). `/ready` is deferred because no external dependencies exist to probe. Unknown routes, including lead and agent paths, return safe 404 envelopes. CORS is a browser policy, not authentication or authorization.

Authentication answers **who the user is**; authorization answers **what this user may do in an organization**; data isolation ensures **every read/write remains within that organization**. None is implemented for tenant data in this phase. See [multi-tenancy](docs/architecture/multi-tenancy.md) and the [threat model](docs/security/threat-model.md).

Cloud resources, credentials, deployments, integrations, business workflows, billing, commits, and pushes are outside the authorized Phase 00 work. Phase 01 requires separate approval.

## Reading path

Start with [the learning guide](docs/learning/phase-00.md), then [system architecture](docs/architecture/overview.md), [monorepo boundaries](docs/architecture/monorepo.md), [multi-tenancy](docs/architecture/multi-tenancy.md), and [agent architecture](docs/architecture/agents.md). The [engineering report](docs/phases/phase-00-report.md) records actual results, remaining risks, and manual testing instructions.
# leadsFAM
