# Design Local Collector STATE Load, Replay, And Persist

## Why

The local collector runner currently drops connector `STATE` messages and never replays prior state into `START`. `collector-runner.ts → collectConnectorMessages` filters for `RECORD` only, and `buildCollectorStartMessage` constructs `START` without a `state` field even though `StartMessage.state?: Record<string, unknown>` already exists in the runtime contract. `LocalDeviceClient` exposes only enrollment, heartbeat, and ingest — there is no state read or state write endpoint on the device-exporter authority.

The owner-authenticated state path at `GET|PUT /v1/state/:connectorId` is keyed by `(connectorId, grantId)` and is explicitly off-limits to device credentials (see `reference-implementation/docs/local-device-exporter.md` Boundaries). Reusing it would either require shipping an owner token onto every collector device (the boundary the device-exporter authority was created to avoid) or introducing a new owner-impersonation grant. Neither is acceptable.

Without a designed state sync lane, every local connector that needs cursors must invent its own out-of-band persistence, and durable long-running shapes like Gmail attachment historical backfill, Chase activity windowing, or Claude/Codex history-tail cursors cannot resume safely after restart, retry, or device replacement.

## What Changes

- Define how prior connector state is loaded by the local collector runner before spawning the connector child.
- Define how the connector's emitted `STATE` messages are persisted by the runner.
- Define a device-scoped state read/write endpoint family under `_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state`, authenticated by the existing device exporter bearer credential.
- Define source-instance isolation for state, matching how device ingest already isolates records under a derived storage connector id.
- Define ordering and crash semantics: state is persisted only after the records that justify it are durably accepted by the server.
- Update the collector runner to feed prior state into the connector's `START` and to forward emitted `STATE` to the server.
- Document that `_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` is reference-only, parallel to the rest of the device-exporter route family, and not a Collection Profile contract.
- Do NOT change `GET|PUT /v1/state/:connectorId` semantics or auth. Owner-auth state remains untouched.
- Do NOT introduce owner credentials into the collector child environment beyond what already exists (`PDPP_LOCAL_DEVICE_TOKEN`, `PDPP_REFERENCE_BASE_URL`, optional `PDPP_RUN_ID`).

## Capabilities

Modified:

- `reference-implementation-architecture`

Added:

- None

Removed:

- None

## Impact

- Affects `packages/polyfill-connectors/src/collector-runner.ts`, `local-device-client.ts`, and adjacent envelope/queue plumbing.
- Affects `reference-implementation/server/index.js` device-exporter route family, `stores/device-exporter-store.js`, and either reuses or wraps `stores/connector-state-store.ts` to keep one source of truth for stored state.
- Affects the local collector runner tasks listed in `introduce-local-collector-runner` (task §4) which today silently drops `STATE`.
- Unlocks Gmail attachment backfill (`add-gmail-attachment-backfill`) by giving the `attachments` stream a real resumable cursor surface when run via the local collector lane. Does not block Gmail backfill that runs server-side under existing owner-auth state.
- Unlocks resumable local Claude/Codex collector cursors (`complete-local-agent-collectors`) without leaking owner authority onto the device.
- No public PDPP API surface changes. The new endpoint family is `_ref/*` and is documented as reference-only.
- No change to the public/source-instance vocabulary question — the design treats `source_instance_id` the same way device ingest already does.
