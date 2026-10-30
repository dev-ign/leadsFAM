# ADR 0009: Local container binding — approved and verified

Status: resolved after explicit user approval. The user approved changing Docker Desktop's default to “Localhost by default.” Local startup, host-binding inspection, clean reset and the database security suite pass. No production deployment was authorized or performed.

## Finding and review

Docker Desktop 4.97.0 / Engine 29.9.2 initially published the local database, API gateway, Studio and Mailpit on `0.0.0.0` and `::`, despite application connection URLs using loopback. A loopback URL is not proof that a listener is private to the host.

The project was stopped with data backed up. A dedicated bridge network was created using Docker's documented `com.docker.network.bridge.host_binding_ipv4=127.0.0.1` option and Supabase CLI 2.122.0's supported `--network-id` flag. The option was present and containers used that network, but actual publication remained wildcard. The startup assertion rejected it and work stopped for review, as requested for a significant security assumption change.

This reproduces the behavior reported in the [Supabase macOS issue](https://github.com/supabase/supabase/issues/51027). Docker documents the bridge option in its [network reference](https://docs.docker.com/engine/network/drivers/bridge/#default-host-binding-address). Runtime inspection takes precedence over assuming that option works through Desktop's VM forwarding layer.

## Approved correction

After approval and unlocking the Mac, Docker Desktop Settings was searched for **Port binding behavior**. The UI showed **Open (Default)**. Exactly that preference was changed to **Localhost by default**, not the stronger “Localhost only” alternative or any unrelated setting. The UI required an engine restart; inspection confirmed no unrelated running containers beforehand.

The applied setting showed no unsaved changes and a running engine. Only LeadsFam's local stack was restarted. Docker mappings and `lsof` on macOS both showed:

| Service     | Port  | Actual host addresses |
| ----------- | ----- | --------------------- |
| API gateway | 54321 | `127.0.0.1`, `::1`    |
| PostgreSQL  | 54322 | `127.0.0.1`, `::1`    |
| Studio      | 54323 | `127.0.0.1`, `::1`    |
| Mailpit     | 54324 | `127.0.0.1`, `::1`    |

The Desktop default affects other containers published without an explicit host address. That broader effect was disclosed and approved. Explicit host publications remain possible; the setting is not a universal policy for all Docker workloads. No firewall rule, unsupported Docker API shim, CLI binary patch or replacement identity architecture was introduced.

## Retained guard and verification

`pnpm db:start` inspects actual database/API/Studio/Mailpit published addresses after startup and stops the stack if any address is outside loopback. `pnpm db:bindings:check`, local credential bootstrap and CI require the same invariant. No bypass flag exists. Configure the Desktop default before first startup: the post-start check detects a regression after container creation, rather than guaranteeing no temporary listener can ever be created.

The bridge option remains for compatible engines and disposable Linux CI. Type generation is different: CLI 2.122.0 runs it in-process and rejects `--network-id`; the launcher omits that flag for `gen types` and uses the host-local database. No schema/type check is skipped.

After applying the correction, clean reset, 61 pgTAP assertions, nine real concurrency tests, 20 Auth/API tests, zero advisor findings and generated-type consistency all passed. Application verification and secret scanning are recorded in the [engineering report](../phases/phase-01-report.md). The applied setting has [screenshot evidence](../phases/screenshots/phase-01-docker-localhost.png).
