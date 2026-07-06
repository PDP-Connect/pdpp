## Why

The owner run-cancel route cancels controller-managed runs, but scheduler-direct runs can also hold `controller_active_runs` rows and connector child processes. When an operator stops one of those runs outside the route, the runtime records a generic connector failure (`connector_exit_without_done`), and source health can present an intentional stop as a connector code defect.

Run cancellation must be run-scoped and consistent regardless of whether the run was launched through `controller.runNow` or the direct scheduler path.

## What Changes

- Extend the owner-session `POST /_ref/runs/{run_id}/cancel` route so it cancels scheduler-direct active runs after the controller reports `no_active_run`.
- Add a scheduler-direct cancellation registration seam keyed by `run_id`.
- Thread cancellation through the existing runtime `AbortSignal` path so direct scheduled runs emit `run.cancel_requested` and terminal `run.cancelled` instead of `run.failed` / `connector_exit_without_done`.
- Preserve `cancelled` in scheduler run history rather than coercing it to `failed`.

## Capabilities

### Modified Capabilities

- `reference-implementation-runtime`: owner cancellation applies to active scheduler-direct runs as well as controller-managed runs, and scheduler history preserves cancelled terminal status.
- `reference-surface-topology`: the run-detail cancel control works for any active run whose server can resolve a cancellation handle, not just controller-managed runs.

## Impact

- Affected code: scheduler direct-run executor, scheduler manager, owner run-cancel route, runtime retry/status typing, tests.
- No public PDPP protocol change. This remains reference/operator control.
- Existing controller-managed cancellation semantics are unchanged.
