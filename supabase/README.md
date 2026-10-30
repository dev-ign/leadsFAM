# Local Supabase and migrations

Phase 01 uses a local Docker Desktop stack only. No project is linked or hosted. The CLI is pinned in `pnpm-lock.yaml`; scripts refuse non-loopback stack URLs and never print generated connection credentials.

On Docker Desktop, first select **Settings → Network → Port binding behavior → Localhost by default** (use the settings search in the current UI; older layouts place Network under Resources). The user approved and applied this setting on this workstation. It changes the default for containers published without explicit host addresses.

From the repository root, with Docker Desktop open and the pinned Node/pnpm selected:

```sh
pnpm install --frozen-lockfile
pnpm db:start
pnpm db:reset
pnpm verify:database
pnpm dev
```

`db:reset` deletes local development data. Stop the development API before resetting. Do not run it against a valuable local dataset; all automated fixtures here are synthetic and disposable. Migrations define the source of truth; the local seed enables organization creation and contains no identities. Signup/verification tests create synthetic accounts using actual Auth and Mailpit and clean them afterward. pgTAP and race fixtures separately establish ordinary-role database policy behavior without pretending to verify JWT signatures.

Local ports: web 5173, API 3001, Supabase API 54321, database 54322, Studio 54323, Mailpit 54324. Mailpit receives only local verification/recovery mail. The stack disables unused Realtime, Storage, Edge Functions and Analytics. The CLI launcher adds Docker Desktop's bundled binary directory on macOS when required. `pnpm db:start` creates a project-scoped bridge network with Docker's `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` option and passes its ID through the supported CLI `--network-id` flag for container-backed commands. Type generation runs in-process against host loopback and omits that flag because CLI 2.122.0 explicitly rejects it. It inspects actual published addresses and stops the stack if any port binds outside loopback. Native `supabase start` without these scripts does not provide that guarantee.

`pnpm dev` builds database/shared/UI exports first. The API launcher gets local stack status internally, generates a session key and database password in a mode-0600 temporary file **outside the repository**, sets only the restricted local runtime role's password, and injects server configuration into the API process. It does not pass credentials into Vite or print them. The generated file is named `leadsfam-local-<workspace hash>.json` in the OS temporary directory. Losing it signs out existing local sessions after a new key is generated. Production has no such bootstrap path and must use a reviewed secret manager.

The database migration administrator is used only for migrations, local bootstrap and synthetic fixtures. Ordinary application persistence uses `leadsfam_runtime`, which cannot read tenant or Auth tables. Tenant RPCs run with the verified user JWT. See ADRs 0005–0008 for the explicit private function privilege boundaries.

Useful commands:

| Command                               | Result                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm db:bindings:check`              | Inspect actual Docker host port bindings; fail on wildcard/LAN addresses |
| `pnpm db:test`                        | pgTAP tenant, grant, helper and recovery tests                           |
| `pnpm test:database`                  | Real competing transactions with lock barriers                           |
| `pnpm test:identity`                  | Real Auth, OTP, cookie, CSRF, refresh, recovery and HTTP tenant tests    |
| `pnpm db:advisors`                    | Local security/performance advisors; warning/error findings fail         |
| `pnpm db:types`                       | Regenerate and format the public schema TypeScript contract              |
| `pnpm db:types:check`                 | Generate in memory and fail if the checked-in type file differs          |
| `pnpm exec supabase stop --no-backup` | Stop/discard the disposable stack                                        |

Create migrations with `pnpm exec supabase migration new <name>` after checking command help. Review SQL grants, RLS, function ownership/search paths and ordinary-role tests together. Verify from a clean reset; never substitute a service-role-only test. Config changes to Auth require stopping and restarting the local stack. No remote connection is selected by these scripts.

For staging/production, apply versioned migrations through a separately approved release procedure; do **not** apply `seed.sql`. Creation defaults to disabled. Review public Auth signup abuse controls, TLS, same-site frontend/API topology, distributed throttling, key rotation/backup, SMTP, audit retention, monitoring and incident recovery before deployment. None of those environments is provisioned here.

Network reference: [Docker bridge host binding](https://docs.docker.com/engine/network/drivers/bridge/#default-host-binding-address). The guard requires actual API/database/Studio/Mailpit publication on loopback addresses. On this macOS Docker Desktop 4.97.0 / Engine 29.9.2 installation, the bridge option alone was ignored. Work stopped for review; the user then approved changing the Desktop-wide default to “Localhost by default.” After applying it and restarting the engine with no unrelated containers running, Docker inspection and macOS listeners both showed only `127.0.0.1` and `::1` for ports 54321–54324. The post-start assertion remains enabled, as do bootstrap and CI binding checks.
