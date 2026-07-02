## Context

The controller direct-run path already has a wall-clock watchdog. The scheduler direct-run path registers active runs through `schedulerStore.upsertActiveRun`, but its attempt awaits `runConnector` without a scheduler-owned cancellation budget. If the attempt stops progressing, the durable active-run row can outlive useful execution and keep owner surfaces in a checking state.

## Decision

Apply the same bounded-run invariant to scheduled direct attempts:

- each scheduler direct attempt gets an `AbortController`;
- the timeout aborts the connector via `cancelSignal`;
- the resulting scheduler record is terminal `failed` with reason `run_timed_out`;
- once the timeout fires, that terminal reason wins even if the connector emits a late `DONE` while shutting down;
- the existing `finally` block clears `controller_active_runs`.

Managed browser-surface scheduled runs continue to route through `controller.runNow`, which already owns the browser lease and controller watchdog. This change does not add connector-specific rules.

## Alternatives

- **Only clean rows at boot.** Insufficient: the bad state can persist until a restart.
- **Delete stale active rows from the UI/read model.** Insufficient: it hides a runtime invariant violation and does not unblock future runs safely.
- **Patch individual connectors.** Insufficient: the failure is a scheduler/runtime lifecycle invariant, not a ChatGPT, Slack, GitHub, or YNAB-specific behavior.

## Acceptance checks

- A scheduler direct attempt that exceeds its budget terminals as `failed` / `run_timed_out`.
- A connector that emits `DONE` during timeout shutdown still terminals as `run_timed_out`.
- The scheduler clears the durable active-run row after timeout.
- Existing scheduler retry/overlap tests still pass.
- Live source rows no longer remain indefinitely stuck on stale active-run state after the timeout/reconciliation path runs.
