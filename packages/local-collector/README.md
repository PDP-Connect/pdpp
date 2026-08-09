# @pdpp/local-collector

Publishable PDPP local collector runtime for filesystem-class connectors.

This package is intentionally narrower than `@pdpp/polyfill-connectors`: it
ships only the local collector runner, the device-exporter client, and bundled
Claude Code / Codex connector entrypoints. Browser/Patchright-backed connectors
stay out of this package until each has its own publishability review.

For filesystem-class collectors, the local device or host supervisor decides
when the process runs. The reference server owns enrollment, ingestion, state,
health diagnostics, and optional desired-freshness/request-run signals, but it
does not start local processes. `PDPP_CONNECTION_ID` is the stable
connection/source identity for a specific device/account/home binding; the
enrollment response currently names that value `source_instance_id`.

## Usage

Guided path — one command pairs the host and saves credentials, no manual
JSON/env-var copying:

```bash
# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
npx -y @pdpp/local-collector setup \
  --base-url https://<reference-host> \
  --code <one-time-code> \
  --connector claude_code \
  --sample 20   # bounded proof pass: verify without collecting the whole archive

# credentials are saved to ~/.config/pdpp/collectors/claude_code.env (0600);
# run resolves them automatically from --connection-id alone:
npx -y @pdpp/local-collector run --connection-id <source_instance_id>
```

`run` prints live progress to stderr as records are found (`--quiet` to
suppress). `--sample <n>` works on `run` too, any time you want a bounded
preview instead of a full collection.

### `connect`: declare a collection horizon at pairing time

`connect` performs the same one-time-code exchange as `setup`, plus an
optional collection-horizon REQUEST — no separate owner-side call needed
first:

```bash
# Recent history only (defaults to 30 days if --recent is given no value):
npx -y @pdpp/local-collector connect \
  --base-url https://<reference-host> \
  --code <one-time-code> \
  --connector claude_code \
  --recent 30

# Explicit full history:
npx -y @pdpp/local-collector connect --base-url https://<reference-host> \
  --code <one-time-code> --connector codex --all

# Custom boundary — since a timestamp, and/or specific project roots:
npx -y @pdpp/local-collector connect --base-url https://<reference-host> \
  --code <one-time-code> --connector claude_code \
  --since 2026-07-01T00:00:00.000Z --source-roots ~/code/project-a,~/code/project-b
```

Exactly one of `--recent`, `--all`, or `--since`/`--source-roots` may be
given; passing none defers entirely to the server. `--since` is validated
locally (must parse as a date/time) and `--source-roots` entries that look
like filesystem paths are `~`-expanded, resolved to absolute paths, and must
exist on this host — before any request is sent, not after a round trip that
would silently collect nothing.

The scope flags are a REQUEST, never a local completeness authority: the
server is the sole arbiter of the effective boundary. A device-declared scope
can only NARROW whatever the server already declared (or defaulted) — a
request that would WIDEN a server-declared boundary is rejected with a typed
error, not silently clamped. When neither side declares a boundary the server
defaults to recent history (30 days), never an implicit full pass.

If a profile already exists at the target name (default: the connector id),
`connect` refuses to overwrite it — doing so silently would leave the OLD
device credential live and un-revoked on the server with no local record left
to revoke it. Pass `--force` to revoke the existing credential first, then
connect and overwrite the profile; a failed revoke aborts before the new code
is consumed, so nothing is lost on a failed retry.

### Bounded collection horizon (recent history vs. full history)

The one-time `--code` above comes from the owner-authenticated
`POST /v1/owner/connections/intents` call that mints it (see
[`docs/reference/local-collector.md`](../../docs/local-collector.md)). That
same call accepts an optional `collection_scope` — `{ since, source_roots }`
— declaring the boundary the collector should run within: recent history
(e.g. `since` 30 days ago), a specific project (`source_roots`), or the
default of no bound (full history). This is the same shape `connect`'s scope
flags above build; declaring it at intent-mint time (owner-side, before a
device ever enrolls) and declaring it via `connect` (device-side, at
enrollment) both apply to every `run` against that connection from then on —
there is no `run`-time flag that can widen or override it, by design: a
local flag must never be able to claim more coverage than the server
actually granted.

`status` and `doctor` report the boundary currently in force for a lane under
`scope.active` (a fingerprint string; `"unscoped"` means a full pass), so you
can always see what a "complete" run on this connection is complete *within*.
A run only reports coverage as committed once it has exhaustively enumerated
that boundary — `--sample`, an interrupted run, or one stopped by the per-run
scan budget always reports `coverage_note` as NOT committed, never a partial
count read as done.

```bash
# List connector ids this build accepts.
npx -y @pdpp/local-collector connectors

# Revoke this device's credential on the reference server, then remove its
# saved local profile. Add --local-only to skip the server call (only for an
# unreachable/decommissioned server — the device token stays live otherwise).
npx -y @pdpp/local-collector logout --connector claude_code

# Preview host-local recovery for a stalled collector lane. This loads the
# enrolled local profile for the source instance and changes nothing.
npx -y @pdpp/local-collector recover --source-instance-id <source_instance_id>

# Apply recovery: requeue failed uploads when present, then run the collector once.
npx -y @pdpp/local-collector recover --source-instance-id <source_instance_id> --apply
```

Low-level / scriptable primitives (unchanged, still supported):

```bash
# @pdpp/local-collector package, npx-launched pdpp-local-collector binary
npx -y @pdpp/local-collector advertise

# enroll prints the raw JSON response instead of saving a profile.
npx -y @pdpp/local-collector enroll \
  --base-url https://<reference-host> \
  --code <one-time-code>

# run with credentials supplied entirely via env vars/flags.
PDPP_LOCAL_DEVICE_ID=<device_id> \
PDPP_LOCAL_DEVICE_TOKEN=<device_token> \
PDPP_CONNECTION_ID=<source_instance_id> \
npx -y @pdpp/local-collector run \
  --base-url https://<reference-host> \
  --connector claude_code
```

The collector sends `X-PDPP-Collector-Protocol` on enrollment and every
device-exporter request. The reference server rejects incompatible versions
before persisting records or state.

Install globally if you prefer a persistent binary:

```bash
# @pdpp/local-collector package, installs the pdpp-local-collector binary
npm i -g @pdpp/local-collector
pdpp-local-collector advertise
```

`device_token` is write-capable for its collector lane. Store it in a secret
manager or root-readable env file, and do not print it in logs, issues, or
support transcripts.

For a full operator runbook, including Docker move guidance and troubleshooting
for `403` after source migration and `409 collector_protocol_mismatch`, see
[`docs/reference/local-collector.md`](../../docs/local-collector.md).
