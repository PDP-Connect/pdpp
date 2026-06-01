## Why

The stalled-outbox operator remediation (archived `add-outbox-stalled-operator-remediation`) gives the owner a visible label and a copy-pasteable command, but no scale: the console can say `Outbox · stalled` without saying *how much* is stuck. The precise counts (pending, dead-letter, stale leases) already exist — devices report `outbox_diagnostics` on each heartbeat, the store persists them, and the per-source diagnostics surface renders them. But the rollup that backs the **connection summary** (`ConnectorSummary.local_device_progress`) drops everything except a single `records_pending` sum. The deferred-here note in `summarizeOutboxForRow` says it plainly: "the connector-summary projection does not currently expose a numeric backlog at this level".

This change promotes the already-collected counts into the connection-summary projection so list/detail remediation can be count-backed, without inventing new device telemetry or leaking device-local internals.

## What Changes

- Roll up the per-source `outbox_diagnostics` the device already reports into a typed `outbox_counts` summary on `LocalDeviceProgress`, scoped to a connection's trusted source instances.
- Source the counts only from heartbeat evidence the server already trusts (active device, active source, not revoked); never read a device's local outbox directly.
- Surface count-backed scale in the console's stalled-outbox remediation copy, while keeping healthy/idle/active/unknown rows quiet.
- Carry no filesystem paths, queue names, device tokens, hostnames, or record payloads in the new field — only non-negative integers and one optional ISO timestamp (`oldest_pending_at`).

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-connection-health`: Add count-backed outbox diagnostics to the local-device connection-summary projection.

### Removed Capabilities

## Impact

- Affected reference code: `reference-implementation/server/ref-control.ts` (`HeartbeatRow`, `projectLocalDeviceProgress`, `LocalDeviceProgress`), `reference-implementation/runtime/connection-health.ts` (pure rollup helper over `OutboxDiagnosticCounts`), companion tests.
- Affected UI: `apps/console/src/app/dashboard/lib/ref-client.ts` (`RefLocalDeviceProgress`), `apps/console/src/app/dashboard/lib/connection-evidence.ts` (count-backed remediation copy), `apps/console/src/app/dashboard/records/[connector]/connection-diagnostics.tsx`, companion tests.
- Affected specs: `reference-connection-health`.
- No change to device-side telemetry, the heartbeat ingest contract, the per-source `device_source_instances` storage, or public grant-scoped read APIs. Counts are owner-only diagnostics.
