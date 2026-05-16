# Local Collector Runbook (Claude Code / Codex)

Status: reference-experimental operator surface. Not PDPP Core or Collection Profile protocol.

This is the single-page operator runbook for running Claude Code and Codex local collectors against a PDPP Docker reference deployment, with resumable connector state. It supersedes the bare `bin/local-device-exporter.ts` flow in `reference-implementation/docs/local-device-exporter.md` &mdash; that script remains as a compatibility shim but does not participate in STATE sync.

## What you are setting up

```
  +-----------------------------+         +---------------------------------+
  |   Host with the data        |         |   PDPP reference deployment    |
  |   (Claude Code / Codex)     |         |   (Docker on a reachable host)  |
  |                             |         |                                 |
  |   pdpp collector enroll  ---|-------->|   POST /_ref/device-exporters/  |
  |                             |  one-   |        enrollment-exchange      |
  |                             |  time   |                                 |
  |   pdpp collector run     ---|-------->|   POST .../ingest               |
  |       --connector            ingest   |   GET|PUT .../state             |
  |       claude_code|codex     |         |                                 |
  +-----------------------------+         +---------------------------------+
```

The reference deployment issues a short-lived enrollment code from `/dashboard/device-exporters`. The host that owns the Claude Code / Codex data exchanges that code for a device-scoped credential, then runs the collector. The credential cannot read records, mint owner tokens, or mutate unrelated devices &mdash; it can only ingest into its own scoped lane. See `openspec/changes/introduce-local-collector-runner`.

State is authoritative on the server. Before each connector pass the runner fetches prior state via `GET /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` and populates `START.state`. After records are durably accepted it flushes the per-stream `STATE` map back via `PUT`. Process crashes between record ingest and state flush replay safely &mdash; `(device_id, batch_id, body_hash)` ingest is idempotent and connectors are idempotent at the record key. See `openspec/changes/design-local-collector-state-sync`.

## Prerequisites

- A PDPP reference deployment reachable at a stable URL (e.g. `http://server.local:7662` or `https://peregrine-dev.vivid.fish`). See `reference-implementation/docs/migrate-storage.md` and the Docker compose under `reference-implementation/docker/` for the deployment side.
- Owner session for that deployment so you can mint enrollment codes from `/dashboard/device-exporters`.
- A PDPP monorepo checkout on the host that owns the data. The collector runner ships with `@pdpp/polyfill-connectors`, not the npm `@pdpp/cli` tarball &mdash; see "Open packaging follow-up" at the end of this runbook.
- `pnpm install` at the repo root on that host.

## Step 1 &mdash; Confirm collector runtime capabilities

On the host with Claude/Codex data, inside the monorepo checkout:

```bash
pnpm exec pdpp collector advertise
```

Expected output (capabilities may grow):

```json
{
  "runtime": "collector",
  "bindings": ["network", "browser", "filesystem", "local_device"]
}
```

Both `claude_code` and `codex` require the `filesystem` binding, which the collector advertises by default. A connector that requires a binding the collector does not advertise will fail before spawn with `runtime_capability_mismatch` &mdash; you do not need to discover that empirically.

## Step 2 &mdash; Mint an enrollment code

In a browser, open `/dashboard/device-exporters` on the reference deployment, signed in as owner.

Use the "Create enrollment code" form:

- Connector id: `claude_code` (or `codex`).
- Local binding: a stable name like `personal-laptop` or `ci-runner-eu-1`. Used by the server to namespace the source-instance id.
- Display name: optional, propagates as the device label.

After "Create code" the dashboard renders:

1. The raw enrollment code (copy button).
2. A pre-filled `pdpp collector enroll` command targeting the deployment's public origin.
3. Pre-filled `pdpp collector run --connector claude_code|codex` commands with `PDPP_LOCAL_DEVICE_ID`, `PDPP_LOCAL_DEVICE_TOKEN`, `PDPP_SOURCE_INSTANCE_ID` placeholders.

You do not need to memorize the route or the env var names; the dashboard advertises the exact command.

## Step 3 &mdash; Enroll the host

On the host with the data, paste the command the dashboard rendered. Example:

```bash
pnpm exec pdpp collector enroll \
  --base-url https://peregrine-dev.vivid.fish \
  --code <one-time-code> \
  --device-label "the owner's laptop"
```

The JSON response shape:

```json
{
  "device_id": "dev_...",
  "device_token": "dvtk_...",
  "source_instance_id": "si_...",
  "...": "..."
}
```

Persist all three. The device token is sensitive (device-scoped ingest only, but still write-capable on this lane). Treat it like an API key &mdash; never commit it.

## Step 4 &mdash; Run a connector pass

Paste the `pdpp collector run` command from the dashboard, filling the three env vars from the enrollment response:

```bash
PDPP_LOCAL_DEVICE_ID=dev_... \
PDPP_LOCAL_DEVICE_TOKEN=dvtk_... \
PDPP_SOURCE_INSTANCE_ID=si_... \
  pnpm exec pdpp collector run \
    --base-url https://peregrine-dev.vivid.fish \
    --connector claude_code
```

Swap `--connector claude_code` for `codex` to ingest Codex CLI history/skills/etc. The runner:

1. Calls `GET .../state` and replays prior connector state into `START.state`.
2. Emits `starting` heartbeat.
3. Spawns the connector subprocess with `START` on stdin.
4. Buffers emitted records and per-stream `STATE` messages.
5. Drains the local queue against `POST .../ingest` until every batch is durably accepted.
6. Calls `PUT .../state` to advance the cursor. If this fails, the heartbeat surfaces `status: "retrying"` with `last_error.kind: "state_put_failed"` and the next pass retries safely.
7. Emits `healthy` (or `blocked` on `GET state` failure).

Run the same command on a schedule (cron, systemd timer, ad-hoc) to keep the lane fresh.

## Step 5 &mdash; Verify on the dashboard

Open `/dashboard/device-exporters`. The device row updates with:

- `fresh` heartbeat (or `stale` if the runner has not heartbeated within the threshold).
- Accepted / rejected ingest counts.
- Per-source-instance breakdown of last ingest time and last error.

`/dashboard/runs` and `/dashboard/grants` show the underlying record/run flow for the connector. For low-level diagnostics, use the `pdpp ref ...` commands &mdash; see `apps/web/content/docs/reference-implementation.md`.

## Recovery and re-runs

- **Re-running the same command**: safe. STATE replays so the connector starts where it left off; ingest is idempotent at `(device_id, batch_id, body_hash)`.
- **Lost the device token**: revoke the device from `/dashboard/device-exporters` and re-enroll a new device. Source-instance ids are stable per `(connector_id, local_binding_name)` so accepted records are not lost.
- **`status: blocked` with `state_get_failed`**: the runner refuses to advance without prior state to avoid over-collecting. Inspect the dashboard for the underlying error (typically a transient AS reach issue or a removed source instance) before retrying.
- **`status: retrying` with `state_put_failed`**: benign; the next pass re-reads state and re-emits records the connector child considered consumed. Server-side idempotency absorbs the duplicates.

## Open packaging follow-up

The collector runner is not yet distributed via the `@pdpp/cli` npm tarball, because shipping Playwright/Patchright/Chromium and the full connector source tree would bloat a public CLI install. From an npm-only install of `@pdpp/cli`, `pdpp collector` exits non-zero with the same monorepo-flow instructions used in step 3 here.

Until the runner is split off into a publishable package, the supported operator path is a monorepo checkout on the host with the data. See "Distribution follow-up" in `openspec/changes/introduce-local-collector-runner/design.md` for the design constraint and follow-up scope. This runbook will be updated when that ships.
