## Why

The connection-health projection collapses every stalled local-device outbox into one message — "Local exporter work is stalled or blocked." — regardless of cause. Three genuinely different host-local situations share that copy: a blocked heartbeat with no dead letters (a failed state read, cleared by re-running the collector), a blocked heartbeat with dead letters (a backlog cleared by retrying dead letters then re-running), and pending work whose heartbeat went stale (the collector died mid-drain). The owner gets one scary, generic line and no way to tell which recovery applies. The distinguishing evidence — heartbeat `status` plus the rolled-up `dead_letter` count plus stale detection — already reaches the projection's caller but is discarded at the `{ axis }` boundary.

## What Changes

- Derive a stalled `cause` (`state_read_failed` | `dead_letter_backlog` | `stale_pending`) from heartbeat evidence the server already holds, alongside the existing `stalled` axis. The four-value outbox axis is unchanged; the cause is carried as condition detail.
- Render cause-specific, non-generic `LocalExporterAvailable` and `BacklogClear` condition messages, reasons, and remediation labels so the dashboard names the exact next host step instead of "stalled or blocked".
- Keep a generic fallback when a stalled axis carries no cause, and never let a non-stalled axis (`idle`/`active`/`unknown`) inherit a cause into scary copy. Name the active state "draining queued work normally" so the healthy-draining case reads as intentionally non-alarming.
- Preserve the decomplection of outbox from scheduler health and the existing operator-remediation rendering contract; this change only sharpens the stalled cause, not the axis taxonomy or any storage shape.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-connection-health`: A stalled local-device outbox SHALL name its cause class in the condition message and remediation, instead of one generic stalled/blocked message.

### Removed Capabilities

## Impact

- Affected runtime: `reference-implementation/runtime/connection-health.ts` (new `OutboxStalledCause`, cause on `deriveOutboxAxisFromHeartbeat` and `ConnectionOutboxEvidence`, cause-specific condition copy), `reference-implementation/server/ref-control.ts` (rollup escalation of the dominant cause; threading into the projection at both summary call sites).
- Affected tests: `reference-implementation/test/connection-health.test.js`.
- No change to the outbox axis enum, the heartbeat wire contract, the device-exporter storage shape, the outbox-counts rollup, or public read APIs. The `dead_letter` count consumed here is already persisted per source instance on heartbeats.
