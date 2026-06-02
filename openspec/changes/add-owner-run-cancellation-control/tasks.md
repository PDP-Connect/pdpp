# Tasks — Owner Run Cancellation Control

## 1. Runtime cooperative cancel

- [x] 1.1 Add an optional `cancelSignal` (`AbortSignal`) option to `runConnector` in `reference-implementation/runtime/index.js`.
- [x] 1.2 On abort, record owner-cancel intent (requested-at) and call the existing `terminateChild()` graceful-then-`SIGKILL` escalation; abort after a terminal event is recorded SHALL be a no-op.
- [x] 1.3 Emit a non-terminal `run.cancel_requested` spine event when cancellation is first observed.
- [x] 1.4 In the no-`DONE` close handler, when owner-cancel was requested, emit terminal `run.cancelled` with `reason: "owner_cancelled"` (child exited within grace) or `reason: "owner_cancel_forced"` (escalated to `SIGKILL`), instead of `run.failed` / `connector_exit_without_done`.
- [x] 1.5 Confirm no staged state is committed on the cancel path (existing behavior; add assertion in tests).

## 2. Controller cancel primitive

- [x] 2.1 Add a module-scoped `activeRunCancellations` map (keyed by `run_id`) holding each run's `AbortController`; populate it in `runNow` and delete it in `finalizeRunCleanup`.
- [x] 2.2 Pass each run's `signal` into `runConnectorImpl` via `cancelSignal`.
- [x] 2.3 Add `cancelRun(runId)` to the `Controller` interface and implementation, returning typed `{ status: "cancel_requested" | "no_active_run" | "already_terminal", run_id }`; `already_terminal` is determined by checking for a terminal spine event.
- [x] 2.4 Ensure `cancelRun` aborts only the targeted run's controller and never touches sibling `activeRuns` / `activeRunPromises` rows.

## 3. Owner-only route

- [x] 3.1 Add `mountRefRunCancel(app, ctx)` registering `POST /_ref/runs/:runId/cancel`, gated by `ctx.requireOwnerSession`, mirroring `mountRefRunInteraction`.
- [x] 3.2 Map controller results to responses: `cancel_requested` → 202, `no_active_run` → 404 `no_active_run`, `already_terminal` → 409 `run_already_terminal`; missing controller → 404 `not_found`.
- [x] 3.3 Wire the route into the server's reference-route registration alongside the existing run-interaction mount.

## 4. Owner-agent catalog metadata

- [x] 4.1 Advertise `cancel_run` as a run-scoped, non-destructive action in the owner-agent control catalog, distinct from `run_connection` / `revoke_connection` / `delete_connection`, without advertising an owner-bearer method/URL it does not serve.

## 5. Tests

- [x] 5.1 Controller test: `cancelRun` on an active run (injected `runConnectorImpl` that observes the signal) returns `cancel_requested`, emits `run.cancel_requested`, and the run settles terminal `run.cancelled`; a second active run is unaffected.
- [x] 5.2 Controller test: `cancelRun` on an unknown run returns `no_active_run`; on a run with a recorded terminal event returns `already_terminal`.
- [x] 5.3 Controller test: after cancel, the cancelled run's `controller_active_runs` row is cleared and a new manual run for the same connector is admitted; the sibling row remains.
- [x] 5.4 Runtime test: a stub connector that exits on `SIGTERM` after abort yields `run.cancelled` `owner_cancelled`; a stub that ignores `SIGTERM` yields `run.cancelled` `owner_cancel_forced`; neither commits staged state and already-flushed records are preserved.
- [x] 5.5 Route test: owner session required; 202/404/409 typed outcomes for the three cases.

## 6. Validation

- [x] 6.1 `openspec validate add-owner-run-cancellation-control --strict`
- [x] 6.2 Targeted `node --test` over the new controller/runtime/route tests.
- [x] 6.3 `git diff --check`.

## Acceptance checks

- `cancelRun(runId)` aborts only the targeted run; sibling active run, its row, and its Promise are untouched (5.1, 5.3).
- Unknown / already-terminal runs return typed results without side effects (5.2).
- Graceful vs. forced cancel both terminal as `run.cancelled` with a distinguishing reason; no staged state committed; flushed records preserved (5.4).
- `POST /_ref/runs/{run_id}/cancel` is owner-only and returns 202/404/409 typed outcomes (5.5).
- The owner-agent catalog advertises `cancel_run` honestly (4.1).

## Residual / owner-only

- [ ] R.1 (owner-only, deferred) Live verification against running deployment. The active Amazon run MUST be left untouched until deploy. Recorded as a residual risk in `design.md`.
- [ ] R.2 (deferred) Owner-agent bearer (`/v1/owner/...`) cancellation route; this tranche ships the owner-session reference route only.
