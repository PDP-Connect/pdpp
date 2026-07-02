## Context

The controller direct-run path already has a run watchdog. The scheduler direct-run path registers active runs through `schedulerStore.upsertActiveRun`, but its attempt awaits `runConnector` without a scheduler-owned cancellation budget. If the attempt stops progressing, the durable active-run row can outlive useful execution and keep owner surfaces in a checking state.

The reference runtime already persists connector `PROGRESS` as `run.progress_reported` events, and `runConnector` exposes an `onProgress` callback to the scheduler. That makes elapsed wall-clock a worse primary signal than progress silence: a large backfill may run for hours legitimately, but a connector phase that publishes no progress for the watchdog window should be cancelled and terminaled.

## Decision

Apply the bounded-run invariant to scheduled direct attempts as a progress watchdog:

- each scheduler direct attempt gets an `AbortController`;
- valid connector progress resets the watchdog deadline;
- if the watchdog expires without progress, it aborts the connector via `cancelSignal`;
- the resulting scheduler record is terminal `failed` with reason `run_timed_out`;
- once the timeout fires, that terminal reason wins even if the connector emits a late `DONE` while shutting down;
- the existing `finally` block clears `controller_active_runs`.

Managed browser-surface scheduled runs continue to route through `controller.runNow`, which already owns the browser lease and controller watchdog.

Slack's `slackdump` phase is the concrete connector gap that exposed the distinction: the wrapper emitted one progress line before spawning `slackdump`, then treated the subprocess as a black box until exit. The Slack connector now samples safe aggregate archive progress — SQLite/WAL byte growth and message/channel/chunk counts when readable — and emits `PROGRESS` only when that aggregate snapshot changes. It does not forward raw `slackdump` stdout/stderr.

## Alternatives

- **Only clean rows at boot.** Insufficient: the bad state can persist until a restart.
- **Delete stale active rows from the UI/read model.** Insufficient: it hides a runtime invariant violation and does not unblock future runs safely.
- **Patch only Slack.** Insufficient: Slack needs progress wiring, but the scheduler still needs a generic no-progress guard for any direct connector phase that goes silent.
- **Pure wall-clock cap.** Too blunt: it can kill a legitimate large backfill that continues publishing progress.

## Acceptance checks

- A scheduler direct attempt that emits no progress for its configured watchdog budget terminals as `failed` / `run_timed_out`.
- A scheduler direct attempt that runs longer than the configured watchdog interval but keeps emitting valid progress is allowed to complete.
- A connector that emits `DONE` during timeout shutdown still terminals as `run_timed_out`.
- The scheduler clears the durable active-run row after timeout.
- Slack `slackdump` archive/resume emits progress from aggregate archive growth while the subprocess is running.
- Existing scheduler retry/overlap tests still pass.
- Live source rows no longer remain indefinitely stuck on stale active-run state after the timeout/reconciliation path runs.
