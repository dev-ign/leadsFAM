# Monorepo and dependency boundaries

A monorepo keeps the UI, API, wire contracts, and tooling changes together. A change to a health response can be checked against its producer and consumer in the same review. This is useful while a small team is discovering the product; it does not require all future services to deploy together.

pnpm workspaces declare local dependencies as `workspace:*`. A misspelled local package cannot silently resolve to a package on the public registry. Exact third-party versions and `pnpm-lock.yaml` record the dependency graph. `strictPeerDependencies`, disabled automatic peer installation, engine checks, a 24-hour release-age policy, blocked exotic transitive sources, and explicit build-script approvals catch incompatible or surprising installations. Only the reviewed esbuild 0.28.2 binary setup script is currently approved.

Turborepo runs dependency builds before consumers and caches declared `dist` outputs locally. `typecheck` and `test` depend on upstream builds so a fresh checkout can resolve package exports. `dev` builds shared packages once and then starts persistent watchers. Remote caching is unconfigured. The web build explicitly hashes VITE_API_BASE_URL and local environment files to prevent stale configuration being restored from cache. Development tasks explicitly allow the non-secret runtime settings through Turbo’s strict environment filter. Root checks include tests; production build configs exclude tests.

| Package             | Owns                                                        | May depend on locally    |
| ------------------- | ----------------------------------------------------------- | ------------------------ |
| `@leadops/web`      | Navigation, presentation, feature lifecycle, HTTP client    | ui, shared, config       |
| `@leadops/api`      | HTTP, configuration, Auth/session and organization services | shared, database, config |
| `@leadops/database` | Server-only PostgreSQL pool and generated schema types      | config                   |
| `@leadops/ui`       | Presentational primitives and design tokens                 | config                   |
| `@leadops/shared`   | Client/server-safe runtime contracts and inferred types     | config                   |
| `@leadops/config`   | Shared TypeScript and ESLint rules                          | none                     |

`node scripts/check-boundaries.mjs` parses imports using the TypeScript syntax tree. It checks workspace dependencies against an allowlist, rejects undeclared dependencies and relative imports escaping a package, rejects Node builtins in browser-safe packages, and detects local module and package cycles. Computed dynamic imports are rejected. ESLint prevents presentation/feature modules from invoking global or member `fetch`. These checks are regression barriers, not a sandbox against malicious code; security review remains necessary, especially for transitive dependencies and new path aliases.

Server build settings use NodeNext ESM with explicit `.js` source import specifiers. Vite uses Bundler resolution for browser modules. UI emits ESM and declarations; Tailwind scans the UI source for class names and consumes its exported token stylesheet. React is a UI peer dependency to avoid a second runtime instance. TypeScript strictness includes unchecked index and exact optional-property checks; library type checking stays enabled.

## Deferred packages

- `apps/worker`: asynchronous job execution after a queue and recovery model are selected.
- `packages/agents`: versioned agent definitions, authorized tool registration, execution adapters.
- `packages/integrations`: email, SMS, lead-source, and booking adapters behind application policy.
- `packages/observability`: telemetry shared by multiple real runtime consumers.

The database package was activated in Phase 01 because the API now consumes its session-store pool and schema types. No empty package manifests were created for the remaining future responsibilities. Create them only with an implemented consumer, explicit graph update, and appropriate tests.
