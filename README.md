# LeadsFam

An industry-agnostic lead acquisition and engagement platform. Phase 03 adds secure first-party intake, PostgreSQL-backed automation and a guided builder to the existing tenant-safe CRM. Its clean-reset and Phase 02F upgrade paths are verified locally; customer data and production deployment are not approved. Real AI calls, customer integrations, email/SMS sending and billing remain deferred. Internal package names retain `@leadops`.

Automations use one versioned definition and one execution/security model. Guided setup is the default; a future visual editor will edit the same workflows. Unsupported configurations are preserved and explained. See the [Phase 03 report](docs/phases/phase-03-report.md), [manual](docs/phases/phase-03-manual.md) and [architecture review](docs/architecture/phase-03.md).

> Docker Desktop prerequisite: select **Port binding behavior → Localhost by default** before the first stack startup. This workstation is configured with user approval. The project also checks actual published addresses; a loopback connection URL alone does not establish a private listener. See [ADR 0009](docs/decisions/0009-local-container-binding-review.md).

## Local setup

Use Node **26.13.0 LTS** from `.nvmrc` and pnpm **12.16.1**. Docker Desktop must be open with an appropriate license. The selected Node release and dependency compatibility are recorded in [ADR 0002](docs/decisions/0002-runtime-and-dependencies.md).

```sh
nvm install
nvm use
npm install --global --allow-scripts=pnpm pnpm@12.16.1
pnpm install --frozen-lockfile
pnpm db:start
pnpm db:reset
pnpm dev
```

Start automation processing in a second terminal with `pnpm worker:dev`. Restart an existing development API after this upgrade so the launcher supplies its separate intake login.

`db:reset` deletes local development data; use it only for this disposable stack and stop development processes first. Open [LeadsFam](http://127.0.0.1:5173), [Mailpit](http://127.0.0.1:54324) for local verification/recovery codes, or [health](http://127.0.0.1:3001/health). Register a synthetic `@example.test` account, verify its code, sign in and create a workspace. No hosted accounts, production credentials or customer systems are needed.

The API launcher generates local session credentials outside the repository, supplies only a public Supabase API key to the server's Auth adapter, and uses a restricted PostgreSQL role for session persistence. No provider token or session secret enters Vite. Startup fails if the database role is privileged. See [local migration instructions](supabase/README.md).

## Commands

| Command                           | Purpose                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm dev`                        | Build shared/database/UI exports, then watch local applications and packages                   |
| `pnpm worker:dev`                 | Run the restricted local automation worker                                                     |
| `pnpm test:automation`            | Focused intake, workflow, fencing, recovery and real-Auth API checks                           |
| `pnpm verify`                     | Blocking formatting, boundaries/lint, strict types, unit/transport tests and production builds |
| `pnpm db:start` / `pnpm db:reset` | Start / cleanly recreate the local schema and local-only seed                                  |
| `pnpm verify:database`            | RLS, concurrency, real Auth/API integration, advisors and database-type drift checks           |
| `pnpm db:types`                   | Regenerate formatted public database types                                                     |
| `pnpm audit:dependencies`         | Full dependency audit; high/critical findings block                                            |
| `pnpm scan:secrets`               | Working tree and Git history scan with provider/session/database detection canaries            |

CI runs these gates with a disposable Docker/Supabase stack, including CRM integration and race tests. Remote CI execution of these changes awaits a separately authorized push; local CI-equivalent checks are recorded in the [Phase 02 engineering report](docs/phases/phase-02-report.md). No deployment job exists. See the [manual testing and benchmark instructions](docs/phases/phase-02-manual.md).

## Repository map

- `apps/web`: React workspace, identity/organizations, CRM/import and guided automation/integration flows, scoped memory-only drafts and one typed API client.
- `apps/api`: Fastify transport, verified Auth adapter, encrypted opaque sessions, authorized CRM/intake, durable automation, agent-safe internal tools and safe logging.
- `packages/database`: server-only PostgreSQL pool, generated schema types and typed user-JWT RPC transport.
- `packages/shared`: browser-safe Zod contracts, role/permission presentation helpers.
- `packages/ui`: accessible primitives and semantic theme tokens.
- `packages/config`: strict TypeScript and ESLint configuration.
- `supabase`: local stack configuration, reviewed migrations, synthetic database policy tests and local mail templates.
- `scripts` / `tests`: boundary enforcement, secret scanning, local launchers and real integration/race tests.
- `docs`: version-controlled architecture, ADRs, threat model, learning guides, reports and test screenshots.

## Security boundary

Authentication proves identity; authorization checks what that identity may do in a workspace; isolation confines rows and references to that workspace. The backend derives organization context from current membership. Database operations check it again under locks and RLS. Recovery credentials cannot enroll as ordinary application sessions. The runtime has no service-role key and cannot directly read tenant or Auth tables.

Production requires a reviewed deployment and operational design: HTTPS and same-site browser/API topology, managed keys/TLS, distributed abuse controls, Auth signup policy, SMTP, monitoring, backups, retention and incident recovery. Public organization creation is disabled in production code and by default in migration settings. The local seed is not a production migration.

Phase 03 work is local and uncommitted. No hosted infrastructure, deployment, customer import, live external integration, commit or push is authorized by this implementation task. Architecture and implementation teaching starts with the [Phase 02 learning guide](docs/learning/phase-02.md), [CRM architecture](docs/architecture/crm.md), [tenant model](docs/architecture/multi-tenancy.md), and [threat model](docs/security/threat-model.md). The [Phase 00](docs/phases/phase-00-report.md) and [Phase 01](docs/phases/phase-01-report.md) reports are historical evidence for their stages.
