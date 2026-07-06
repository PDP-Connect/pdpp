## Design

The direct scheduler path already passes an `AbortSignal` to `runConnector`, but today that signal is private to the progress watchdog. The fix keeps the runtime as the single owner of child-process termination and exposes only a cancellation handle:

- `createScheduler` accepts `registerRunCancellation(entry)`.
- The run executor registers an entry once the runtime emits `run.started` and the concrete `run_id` is known.
- The entry's `cancel()` aborts the same attempt signal with a non-timeout reason.
- The runtime's existing abort listener records `run.cancel_requested`, terminates the connector child, and emits terminal `run.cancelled` when the child exits.
- The registration is removed in the same finally path that clears `controller_active_runs`.

The owner route keeps its current controller-first behavior. If `controller.cancelRun(runId)` returns anything other than `no_active_run`, the route returns that result. If the controller reports `no_active_run`, the route calls an optional scheduler cancellation callback. If neither surface owns the run, the existing `404 no_active_run` response remains.

Scheduler run history must represent runtime terminal status. A runtime `cancelled` result is not a connector failure, so the scheduler stores `cancelled` instead of coercing every non-success to `failed`.

## Alternatives Considered

- Kill scheduler connector processes from the server route. Rejected because it splits child lifecycle ownership and recreates the exact operator-stop failure mode.
- Treat scheduler-direct cancellation as a scheduler-only failed record. Rejected because source health would still confuse intentional cancellation with connector breakage.
- Add a connection-scoped stop route in this tranche. Rejected as broader than the observed bug; run-scoped cancellation is already the existing control contract.

## Acceptance Checks

- A direct scheduled run registers a cancellation handle after `run.started`.
- `POST /_ref/runs/{run_id}/cancel` returns `202 cancel_requested` for that direct scheduled run.
- The runtime records `run.cancel_requested` and terminal `run.cancelled` with owner-cancel reason.
- `scheduler_run_history.status` stores `cancelled` for the run.
- Unknown and already-terminal route behavior remain typed and unchanged.
