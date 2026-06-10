# Local Collector Runbook (Claude Code / Codex)

Status: reference-experimental operator surface. Not PDPP Core or Collection Profile protocol.

This is the single-page operator runbook for running Claude Code and Codex local collectors against a PDPP Docker reference deployment, with resumable connector state. It supersedes the bare `bin/local-device-exporter.ts` flow in `reference-implementation/docs/local-device-exporter.md` &mdash; that script remains as a compatibility shim but does not participate in STATE sync.

## What you are setting up

```
  +-----------------------------+         +---------------------------------+
  |   Host with the data        |         |   PDPP reference deployment    |
  |   (Claude Code / Codex)     |         |   (Docker on a reachable host)  |
  |                             |         |                                 |
  |   pdpp-local-collector   ---|-------->|   POST /_ref/device-exporters/  |
  |                             |  one-   |        enrollment-exchange      |
  |                             |  time   |                                 |
  |   pdpp-local-collector   ---|-------->|   POST .../ingest               |
  |       --connector            ingest   |   GET|PUT .../state             |
  |       claude_code|codex     |         |                                 |
  +-----------------------------+         +---------------------------------+
```

The reference deployment issues a short-lived enrollment code from `/dashboard/device-exporters`. The host that owns the Claude Code / Codex data exchanges that code for a device-scoped credential, then runs the collector. The credential cannot read records, mint owner tokens, or mutate unrelated devices &mdash; it can only ingest into its own scoped lane. See `openspec/changes/introduce-local-collector-runner`.

State is authoritative on the server. Before each connector pass the runner fetches prior state for the local connection via `GET /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` and populates `START.state`. After records are durably accepted it flushes the per-stream `STATE` map back via `PUT`. Process crashes between record ingest and state flush replay safely &mdash; `(device_id, batch_id, body_hash)` ingest is idempotent and connectors are idempotent at the record key. See `openspec/changes/design-local-collector-state-sync`.

## Prerequisites

- A PDPP reference deployment reachable at a stable URL (e.g. `http://server.local:7662` or `https://peregrine-dev.vivid.fish`). See `reference-implementation/docs/migrate-storage.md` and the Docker compose under `reference-implementation/docker/` for the deployment side.
- Owner session for that deployment so you can mint enrollment codes from `/dashboard/device-exporters`.
- Node.js 22.14+ and npm on the host that owns the data.
- `@pdpp/local-collector@beta` installed globally, or
  `npx -y @pdpp/local-collector@beta` available for one-shot execution until
  the package is promoted from beta to latest. A PDPP monorepo checkout is only
  needed for development or unpublished connector work.
- On an operator host, pin a **published** version or dist-tag and confirm the
  `pdpp-local-collector` binary does not resolve into a repo `dist/` tree before
  trusting its output as operator evidence. Do not use the `latest` dist-tag —
  it is currently the placeholder `0.0.0`. See
  `docs/local-collector.md`§"Deployment Posture: Published vs Dev".

## Step 1 &mdash; Confirm collector runtime capabilities

On the host with Claude/Codex data:

```bash
npx -y @pdpp/local-collector@beta advertise
```

Expected output (capabilities may grow):

```json
{
  "runtime": "collector",
  "bindings": ["network", "filesystem", "local_device"],
  "collector_protocol_version": "1",
  "bundled_connectors": ["claude_code", "codex"]
}
```

Both `claude_code` and `codex` require the `filesystem` binding, which the collector advertises by default. The published package intentionally does not bundle the `browser` binding; browser-bound connectors stay in the monorepo until each has its own publishability review. A connector that requires a binding the collector does not advertise will fail before spawn with `runtime_capability_mismatch` &mdash; you do not need to discover that empirically.

## Step 2 &mdash; Mint an enrollment code

In a browser, open `/dashboard/device-exporters` on the reference deployment, signed in as owner.

Use the "Create enrollment code" form:

- Connector id: `claude_code` (or `codex`).
- Local binding: a stable name like `personal-laptop` or `ci-runner-eu-1`. Used by the server to namespace the connection id. Existing server responses still expose this compatibility field as `source_instance_id`.
- Display name: optional, propagates as the device label.

After "Create code" the dashboard renders:

1. The raw enrollment code (copy button).
2. A pre-filled `npx -y @pdpp/local-collector@beta enroll` command targeting the deployment's public origin.
3. Pre-filled `npx -y @pdpp/local-collector@beta run --connector claude_code|codex` commands with `PDPP_LOCAL_DEVICE_ID`, `PDPP_LOCAL_DEVICE_TOKEN`, `PDPP_CONNECTION_ID` placeholders.

You do not need to memorize the route or the env var names; the dashboard advertises the exact command.

## Step 3 &mdash; Enroll the host

On the host with the data, paste the command the dashboard rendered. Example:

```bash
npx -y @pdpp/local-collector@beta enroll \
  --base-url https://peregrine-dev.vivid.fish \
  --code <one-time-code> \
  --device-label "the owner's laptop"
```

The JSON response shape:

```json
{
  "device_id": "dev_...",
  "device_token": "dvtk_...",
  "connector_instance_id": "cin_...",
  "source_instance_id": "si_...",
  "...": "..."
}
```

Persist the device id, device token, and `source_instance_id`. `connector_instance_id` is the server-side connection id for owner-facing diagnostics; the collector command still passes the device-binding selector as `PDPP_CONNECTION_ID`. The device token is sensitive (device-scoped ingest only, but still write-capable on this lane). Treat it like an API key &mdash; never commit it.

## Step 4 &mdash; Run a connector pass

Paste the `@pdpp/local-collector@beta run` command from the dashboard, filling the three env vars from the enrollment response:

```bash
PDPP_LOCAL_DEVICE_ID=dev_... \
PDPP_LOCAL_DEVICE_TOKEN=dvtk_... \
PDPP_CONNECTION_ID=si_... \
  npx -y @pdpp/local-collector@beta run \
    --base-url https://peregrine-dev.vivid.fish \
    --connector claude_code
```

Swap `--connector claude_code` for `codex` to ingest Codex CLI history/skills/etc. The runner:

1. Recovers expired outbox leases (work a crashed prior run left claimed).
2. **Drains the existing durable outbox first.** Any record batches, checkpoints, or gaps already queued for this connection are sent against `POST .../ingest` before anything else.
3. **Backlog guard.** If durable work is still pending after that drain (ingest is failing, or the queue-depth ceiling is reached), the runner does **not** spawn the connector child. It heartbeats the honest backlog status and exits, so a scheduled run can never re-scan and re-enqueue the same tranche on top of an undrained backlog. The pending work continues to drain on the next pass.
4. Otherwise: calls `GET .../state`, replays prior connector state into `START.state`, emits `starting`, and spawns the connector subprocess with `START` on stdin.
5. Buffers emitted records and per-stream `STATE` messages, draining record batches against `POST .../ingest` as they fill.
6. Calls `PUT .../state` to advance the cursor only after the record drain succeeds. If the state flush fails, the heartbeat surfaces `status: "retrying"` and the next pass retries safely.
7. Emits `healthy` (or `blocked` on `GET state` failure / dead-letter backlog).

Run the same command on a schedule (cron, systemd timer, ad-hoc) to keep the lane fresh. Because durable backlog wins over source scanning, running more often than a slow lane can drain is safe: extra invocations drain backlog and exit rather than piling on duplicate scans.

> **Persistent state, not `/tmp`.** The durable outbox (`PDPP_COLLECTOR_QUEUE`, default under the package's `.pdpp-data/`) is what carries undrained backlog between runs and makes the backlog guard above work. Keep it — and any captured `run`/`doctor` JSON or `PDPP_DEBUG_CONNECTOR_PROTOCOL_DIR` dump — on a persistent, disk-backed directory (`$XDG_STATE_HOME`/`~/.local/state` on Linux, `~/Library/Application Support` on macOS). On hosts where `/tmp` is a RAM-backed `tmpfs`, pointing the outbox or a large captured summary at `/tmp` consumes memory and loses the backlog on reboot, which defeats the guard and forces a full re-scan. See `docs/local-collector.md`§"Persistent State And Scratch Paths".

## Step 5 &mdash; Verify on the dashboard

Open `/dashboard/device-exporters`. The device row updates with:

- `fresh` heartbeat (or `stale` if the runner has not heartbeated within the threshold).
- Accepted / rejected ingest counts.
- Per-connection breakdown of last ingest time and last error.

`/dashboard/runs` and `/dashboard/grants` show the underlying record/run flow for the connector. For low-level diagnostics, use the `pdpp ref ...` commands &mdash; see `apps/web/content/docs/reference-implementation.md`.

## Recovery and re-runs

- **Re-running the same command**: safe. STATE replays so the connector starts where it left off; ingest is idempotent at `(device_id, batch_id, body_hash)`.
- **Lost the device token**: revoke the device from `/dashboard/device-exporters` and re-enroll a new device. Connection ids are stable per `(connector_id, local_binding_name)` so accepted records are not lost; older routes and JSON still call this `source_instance_id`.
- **`status: blocked` with `state_get_failed`**: the runner refuses to advance without prior state to avoid over-collecting. Inspect the dashboard for the underlying error (typically a transient AS reach issue or a removed source instance) before retrying.
- **`status: retrying` with `state_put_failed`**: benign; the next pass re-reads state and re-emits records the connector child considered consumed. Server-side idempotency absorbs the duplicates.

## Coverage and excluded stores

A successful Claude Code or Codex run **does not** mean every file in your
`~/.claude` or `~/.codex` directory was collected. The connectors intentionally
classify each known local store into one of five buckets before emitting anything:

| Status            | What you see in dashboards                  | What the connector does                                 |
|-------------------|---------------------------------------------|---------------------------------------------------------|
| `collected`       | Real records on the records page            | Reads and emits content into a payload-bearing stream   |
| `inventory_only`  | Records with `relative_path`, size, mtime   | Emits a safe inventory entry, never the file's content  |
| `excluded`        | Only a `coverage_diagnostics` row           | Never reads or emits the file. Used for auth-adjacent files like `auth.json` |
| `deferred`        | Only a `coverage_diagnostics` row           | Known store; not yet collected because redaction or owner review is pending |
| `missing`         | Only a `coverage_diagnostics` row           | Known store not present in your source home for this run |

**Why excluded and inventory-only stores are not collection failures.**
A run is "complete" when every *known* local store is *accounted for*, not when
every file is copied to the server. Auth-adjacent files like `auth.json` are
deliberately never read &mdash; copying them into reference storage before a
security review would itself be the privacy risk we are guarding against. Raw
cache, backup, and configuration files are inventoried (path hash, size,
mtime) without payload so you can see they exist without exposing their
contents. The dashboard's coverage view counts both `collected` and accounted-for
non-collected statuses as "complete"; only `missing` (known store gone) and
`unsupported` (a future tool release added a store the connector does not yet
know about) count against completeness.

If a connector reports a store as `deferred`, that is a deliberate "we know it's
there, we have not yet decided how to surface it safely" signal &mdash; not a
bug. The current deferred set is documented in
`openspec/changes/complete-local-agent-collectors/design-notes/stream-contracts.md`.

**Requesting the coverage diagnostic.** Coverage rides on the
`coverage_diagnostics` stream in `START.scope.streams`. The standard Step 4
invocation (`@pdpp/local-collector@beta run --connector claude_code|codex`
with no `--streams`) now requests `coverage_diagnostics` by default, so a
plain run emits the per-store status without any extra flag. Only an ad-hoc
invocation that passes an explicit `--streams` list opts *out* of coverage —
re-add `coverage_diagnostics` to that list to keep the per-store status. The
connector emits the coverage rows even when a requested content source is
missing (each absent store is reported `missing`), so a partial source home
still produces an honest, non-empty coverage signal rather than failing with
zero coverage evidence.

> **Upgrading from an older collector.** A host enrolled before this default
> shipped may have run a `@pdpp/local-collector` build whose bundled stream
> set did not include `coverage_diagnostics`. Such a host shows
> `SourceCoverageComplete: coverage_unknown` on `/_ref/connectors` even after
> a clean drain, because it never emitted the durable coverage signal the
> rollup derives that axis from. Re-run the standard Step 4 command with the
> current `@pdpp/local-collector@beta` (no `--streams`) once; the next pass
> emits the full coverage diagnostic and the axis promotes to `complete`
> (or names the unaccounted store as a gap). No re-enrollment is needed —
> connection ids are stable per `(connector_id, local_binding_name)`.

## Completeness sanity check

The dashboard's per-connection record count reflects only records the server
has retained. A local collector can have additional work pending in its
outbox that has not yet been drained &mdash; counting those as zero would
make the dashboard imply completeness it cannot guarantee. Two lightweight
checks let you verify the two sides agree without deep forensic work.

**Device side.** From the same host where the collector runs:

```bash
PDPP_LOCAL_DEVICE_ID=dev_... \
PDPP_LOCAL_DEVICE_TOKEN=dvtk_... \
PDPP_CONNECTION_ID=si_... \
  npx -y @pdpp/local-collector@beta doctor
```

The JSON output's `outbox.counts` carries `pending`, `retrying`, `leased`,
`dead_letter`, and `sent` totals for the local SQLite outbox keyed by the
configured `source_instance_id`. `status: "ok"` means no dead-letter rows
and a healthy lease table; `status: "warning"` or `"critical"` points at
the specific check that failed.

Both `status` and `doctor` also report a single `lifecycle_state` for the
lane, derived from the outbox alone, so you do not have to infer the
situation from raw counts. It is exactly one of:

| `lifecycle_state`   | Meaning                                                                 | Action |
|---------------------|-------------------------------------------------------------------------|--------|
| `healthy_idle`      | Fully drained; coverage accounted for (or nothing collected yet)        | None |
| `draining`          | Claimable-now or leased work exists — actively moving records           | None; let the run/schedule continue |
| `retryable_backlog` | Ready work remains but all of it is waiting on retry backoff            | None; the next scheduled run drains it |
| `dead_letter`       | Rows exhausted retries and need recovery                                | `retry-dead-letters` (preview, then `--apply`), then re-run |
| `stale_lease`       | A prior run crashed mid-drain and left a lease past expiry              | None; the next run recovers it automatically |
| `coverage_missing`  | Collected records but never carried a `coverage_diagnostics` record (the local shape behind a stuck dashboard `coverage_unknown`) | Re-run with the default stream set (no `--streams`) once |

The `coverage` block (`observed`, `record_batches`) is the evidence behind
`coverage_missing`: `observed: false` with `record_batches > 0` means the
lane drained real records but no coverage diagnostic. `observed` is `null`
when the surface cannot answer it — either no connection id scoped the scan,
or the outbox predates the coverage index and its unindexed backlog is larger
than the bounded scan budget (see below). `doctor` adds a `coverage_diagnostics`
check (`ok`/`warn`) and a one-line remediation hint for any non-`ok` state.

> **Coverage detection is payload-light and bounded.** Coverage observation is
> answered from a small per-stream index the outbox maintains on every enqueue,
> not by reparsing record payloads — so `doctor`/`status` stay fast even on a
> multi-gigabyte retained outbox. An outbox created before that index existed
> backfills lazily and bounded the first time it is probed; if such a legacy
> outbox has more unindexed record batches than the scan budget, the probe
> reports `observed: null` (unknown) rather than launch an unbounded scan.
> Running the collector once more indexes the lane going forward, after which
> the coverage answer is exact. `observed: null` is never treated as
> `coverage_missing` — the surface does not guess from a partial scan.

**Server side.** Hit `/_ref/device-exporters/source-instances` (or read it
through `/dashboard/device-exporters`) and compare per source instance:

- `accepted_record_count` &mdash; records the server has durably retained.
- `records_pending` &mdash; the latest heartbeat's snapshot of work still
  queued on the device. The records-list header surfaces the sum of this
  field across all enrolled sources as `+N pending on devices` whenever it
  is non-zero, so an owner glancing at the dashboard sees the gap rather
  than a falsely complete total.
- `outbox_state` &mdash; one of `drained`, `pending`, `retrying`,
  `backlog`, `stale`, `dead_letter`, or `unknown`. Anything other than
  `drained` means the device still owes the server work; chase down the
  reason on the device with `doctor`.

When `outbox.counts.pending` on the device equals `records_pending` reported
by the server, and `outbox.counts.dead_letter` is zero, you have
reasonable confidence the two sides agree: every batch the collector has
locally is either already retained or accounted for as pending. If they
diverge, the most common causes are (a) the collector is mid-drain and a
new heartbeat will reconcile them within a minute, or (b) the device token
has been revoked or rotated and ingest is failing &mdash; the device's
last `last_error` and the device-exporters page surface that case
honestly.

This is intentionally a coarse check, not a forensic one. For per-record
attribution, use the connector's `coverage_diagnostics` stream described
above.

## Docker moves and URL changes

When the Docker reference deployment moves, update `PDPP_REFERENCE_BASE_URL` in
each collector env file. If the database moves with the deployment, keep the
existing `PDPP_LOCAL_DEVICE_ID`, `PDPP_LOCAL_DEVICE_TOKEN`, and
`PDPP_CONNECTION_ID` values. If the new deployment starts from a fresh database,
re-enroll each host from `/dashboard/device-exporters`; old device credentials
are scoped to the old database.

For the consolidated public docs, see `docs/local-collector.md`.
