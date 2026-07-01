## Context

The spine summary fallback treats a `run.started` correlation with no terminal
event as `in_progress` only when `controller_active_runs` still contains the
run id. Otherwise it projects a failed `orphaned_started_run`. That rule was
correct for controller-managed runs because `controller.runNow` persists and
clears the active-run row around the connector promise.

The direct scheduler path did not publish the same durable liveness row. It
kept only an in-memory scheduler `activeRuns` set, which prevents duplicate
scheduler dispatch but is invisible to the spine/read projection. A long
direct scheduled run can therefore look orphaned until it eventually emits its
terminal event.

## Decision

Use the existing scheduler store active-run registry for direct scheduled
attempts too.

`runtime/scheduler/run-executor.ts` already receives:

- `schedulerStore`, the semantic active-run persistence seam;
- `onStarted`, the runtime callback carrying the real `run_id` and `trace_id`
  immediately after `run.started` is emitted;
- the schedule's `connector_id`, `connector_instance_id`, and attempt number.

The direct attempt will upsert an active-run record inside the `onStarted`
callback and delete it in the attempt `finally` block after the connector
settles. The attempt awaits any pending upsert before deleting so fast failures
cannot leave a stale row by racing delete ahead of upsert.

## Alternatives

- Change the projection to ignore `orphaned_started_run` for scheduled runs.
  Rejected: it would hide real missing-terminal defects and would still leave
  no durable liveness evidence during active direct scheduler runs.
- Add a new scheduler-specific liveness table. Rejected: the existing
  active-run registry is already the runtime-wide source the projection reads.
- Route every scheduled run through `controller.runNow`. Deferred: managed
  browser-surface connectors already use that path. For direct connectors,
  this would expand controller coupling beyond the bug.

## Acceptance Checks

- A direct scheduled run writes an active-run row after `run.started`.
- The active-run row is removed after the attempt settles.
- A started-only direct scheduled run is projected as active while the row is
  present, not as `orphaned_started_run`.
- Existing managed scheduled runs continue to use the controller path.
