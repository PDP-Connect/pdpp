# Design: classify stalled outbox cause

## Context

`deriveOutboxAxisFromHeartbeat` already branches on exactly the evidence that distinguishes the three stalled situations — it just throws the distinction away. A `blocked` heartbeat returns `stalled`; pending-plus-stale returns `stalled`; both reach `localExporterAvailableCondition` as an indistinguishable `axes.outbox === "stalled"`, which emits the union message "Local exporter work is stalled or blocked." The caller (`ref-control.ts`) already reads each source instance's `outboxDiagnostics` (including `dead_letter`) and `lastHeartbeatStatus` to build the outbox-counts rollup, so no new device telemetry or wire field is needed to recover the cause.

This mirrors a split the device side already makes: accepted source work surfaced `last_error.kind = "state_read_failed"` vs `"dead_letter_backlog"` in the doctor/heartbeat path. This change brings the dashboard projection into parity with that device-side classification.

## Decision: carry cause as condition detail, not a new axis value

The outbox axis stays `idle | active | stalled | unknown`. Widening it to four stalled variants would break every consumer that switches on the axis (records-list cues, summary buckets, remediation gating) and contradict the spec requirement that non-stalled outboxes stay quiet. Instead the cause rides as an optional discriminator (`OutboxStalledCause`) on the outbox evidence and is rendered into the existing `LocalExporterAvailable` / `BacklogClear` condition messages, reasons, and remediation labels. Consumers that already key off `axes.outbox === "stalled"` keep working unchanged; consumers that want the cause read the condition reason.

## Decision: derive the state-read vs dead-letter split from the dead-letter count

A `blocked` heartbeat with a positive rolled-up `dead_letter` count is `dead_letter_backlog`; a `blocked` heartbeat with none is `state_read_failed`. This is the same signal the device-side `last_error.kind` uses, computed here from evidence the server already persists rather than trusting a free-text field. Pending-plus-stale is `stale_pending`.

## Decision: most-actionable cause wins the rollup

When a connection's trusted sources disagree, the dominant cause is the most actionable: `dead_letter_backlog` (retry-then-rerun) > `state_read_failed` (rerun) > `stale_pending` (rerun). Dead letters are the only case that needs a distinct first step, so they surface first. The escalation is order-independent.

## Out of scope

- Widening or renaming the outbox axis enum.
- Any change to the heartbeat wire contract, device-exporter storage, or outbox-counts rollup.
- Console rendering of the new cause copy beyond what the projection already exposes (the console already renders `condition.remediation.label` and message verbatim per the stalled-remediation contract).
- Host-local recovery itself (owner-mediated; unchanged).

## Acceptance checks

- `deriveOutboxAxisFromHeartbeat` returns `cause: "state_read_failed"` for a blocked heartbeat with zero dead letters, `"dead_letter_backlog"` with dead letters, `"stale_pending"` for stale pending work, and `null` for every non-stalled axis.
- `computeConnectionHealth` renders a distinct `LocalExporterAvailable` reason and message per cause, a cause-matched remediation label, a generic fallback when a stalled axis carries no cause, and ignores a cause on a non-stalled axis.
- `node --test --experimental-strip-types reference-implementation/test/connection-health.test.js` passes.
