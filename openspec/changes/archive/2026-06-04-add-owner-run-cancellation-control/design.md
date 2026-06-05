# Owner Run Cancellation Control — Design

## Scope

In scope:

- One owner-only route that requests cancellation of a single active controller-managed run by `run_id`.
- A controller `cancelRun(runId)` primitive that signals only that run.
- Cooperative connector-child termination in the runtime, reusing the existing graceful-then-`SIGKILL` escalation.
- A non-terminal `run.cancel_requested` audit event and a terminal `run.cancelled` event that records whether the child stopped gracefully or had to be force-killed.
- Single-run `controller_active_runs` cleanup (already handled by the existing finalize path).
- Catalog metadata advertising `cancel_run`.

Out of scope:

- Cancelling by `connection_id` rather than `run_id` (a connection has at most one active run; `run_id` is the precise handle and the timeline key). A connection-scoped convenience wrapper can be a later slice.
- A cooperative in-connector cancel hook beyond process signals. Connectors are terminated via signal; a connector-authored `DONE(cancelled)` path is allowed but not required.
- Committing staged cursor state on cancel. Cancellation deliberately leaves staged state uncommitted.
- Dashboard UI. The route and tests ship first; the dashboard button is a follow-up unless it is cheap and coherent within this lane.

## Mechanism: how the controller signals one run

The controller holds each run's in-flight Promise in `activeRunPromises` (keyed by `run_id`) but does **not** hold the connector child process — `runConnector` (runtime/index.js) owns `proc` and already implements a `terminateChild()` graceful-`SIGTERM`-then-`SIGKILL` escalation (currently used only on protocol violations).

Decision: pass an **`AbortSignal`** into `runConnector` via a new optional `cancelSignal` option.

- The controller creates one `AbortController` per run at `runNow` time and stores it in a module-scoped `activeRunCancellations` map keyed by `run_id`. The map entry is deleted in the same `finalizeRunCleanup` path that already clears `activeRuns`/`activeRunPromises`, so no entry outlives its run.
- `runConnector` registers an `abort` listener on the signal. On abort it (1) records `ownerCancelRequested = true` and the requested-at timestamp, (2) emits a non-terminal `run.cancel_requested` event, and (3) calls the existing `terminateChild()`. If the run already has a terminal event recorded, abort is a no-op.
- `cancelRun(runId)` looks up the controller's cancellation entry. If there is no active run for `runId`, it returns `{ status: "no_active_run" }`. If the run already has a terminal spine event, it returns `{ status: "already_terminal" }`. Otherwise it aborts the signal and returns `{ status: "cancel_requested", run_id }`.

Why `AbortSignal` rather than leaking `proc` to the controller:

- It keeps the runtime's exclusive ownership of the child stdio/lifecycle intact. The controller never touches `proc`, so the closed-pipe and SIGKILL-escalation defenses in `runConnector` remain the single owner of process death.
- It is inherently single-run scoped: aborting run A's controller does nothing to run B's child.
- It is trivially testable: a fake `runConnectorImpl` can observe the signal without spawning a process, and the runtime path can be tested with a stub connector that ignores `SIGTERM` to exercise the force-kill branch.
- It composes with graceful shutdown: `drainActiveRuns` continues to await the same run Promise; an aborted run settles through the normal `finally` cleanup.

## Terminal-state semantics

Cursor-commit safety is already guaranteed by the existing runtime: staged `STATE` is committed **only** on `DONE status="succeeded"` (runtime/index.js close handler). The no-`DONE` exit path commits nothing. A cancelled run exits without `DONE`, so:

- Already-flushed records are preserved (records flush per-`RECORD`, independent of state commit).
- Staged cursor state is NOT committed. This matches the design note's requirement and needs no new guard — only a regression test asserting it.

When the child exits after an owner cancel with no `DONE`, the runtime emits a terminal **`run.cancelled`** event (not `run.failed`) carrying:

- `reason: "owner_cancelled"` when the child stopped within the graceful window, or `reason: "owner_cancel_forced"` when `terminateChild()` had to escalate to `SIGKILL`.
- the usual terminal data (records emitted, checkpoint summary with uncommitted staged state, known gaps).

`run.cancelled` is already in `RUN_TERMINAL_EVENT_TYPES` (spine.ts), so run-status projection, abandoned-run reconciliation, and `run_already_active` clearing all treat it as terminal with no extra wiring. `run.cancel_requested` is a new non-terminal event; `emitSpineEvent` does not enforce a closed event-type allow-list, so it needs no registration.

If the connector cooperatively emits `DONE status="cancelled"` (already a valid DONE status the runtime accepts), that path already produces `run.cancelled` with `connector_reported_cancelled`; owner-cancel intent is preserved either way.

## Auth and ownership

The route uses the established `requireOwnerSession` middleware and `{ contract }` registration, identical to `mountRefRunInteraction`. Cancellation is owner-only; there is no agent/client surface. The owner-agent bearer equivalent is deferred — the design note's first tranche is the owner-session reference route, and the owner-agent catalog only advertises the action's existence.

A run started by the owner session is owner-owned by construction (the controller is single-owner per instance). The route does not need a per-run owner check beyond the session gate, matching the existing `/_ref/runs/{run_id}/interaction` posture.

## Typed results

`cancelRun` and the route distinguish:

- `cancel_requested` (202) — an active run existed and was signaled.
- `no_active_run` (404, `no_active_run`) — no in-memory active run for that `run_id`.
- `already_terminal` (409, `run_already_terminal`) — the run has a terminal spine event; nothing to cancel.
- unauthorized (401/403) — handled by `requireOwnerSession`, never reaching the handler.

Cancellation is acknowledged asynchronously: the route returns `cancel_requested` once the signal is raised; the terminal `run.cancelled` event lands when the child actually exits. This mirrors `runNow` returning `started` before the run completes.

## Alternatives considered

- **Leak the child `proc` to the controller and kill it there.** Rejected: splits child-lifecycle ownership across two modules, duplicates the closed-pipe/SIGKILL defenses, and risks the controller killing the wrong process after a run-id reuse.
- **Cancel via the interaction broker (`respondToInteraction(..., cancelled)`).** Rejected: only works when a run is *paused on an interaction*; the motivating ChatGPT case was past the interaction phase and actively collecting. Interaction-cancel also does not terminate the child.
- **Synchronous cancel that waits for child exit before responding.** Rejected: a connector ignoring `SIGTERM` would hang the HTTP request up to the SIGKILL window. Async ack + terminal event is the honest shape and matches `runNow`.
- **New terminal reason on `run.failed` instead of `run.cancelled`.** Rejected by the design note's leaning: an intentional owner cancel should terminal as `run.cancelled`; the graceful-vs-forced distinction is carried in `reason`, not by downgrading to `failed`.

## Acceptance checks

1. `cancelRun` on an active run aborts only that run's signal, emits `run.cancel_requested`, and the run settles to a terminal `run.cancelled` event; a sibling active run is unaffected (its active-run row and Promise remain).
2. `cancelRun` on an unknown `run_id` returns `no_active_run`; on a run with a terminal event returns `already_terminal`.
3. A connector that exits within the graceful window after abort yields `run.cancelled` with `reason: "owner_cancelled"`; a connector that ignores `SIGTERM` yields `run.cancelled` with `reason: "owner_cancel_forced"` after the SIGKILL escalation.
4. After a cancel, the `controller_active_runs` row for that run is cleared and `run_already_active` no longer fires for the connector; sibling rows remain.
5. Already-flushed records persist and no staged cursor state is committed on cancel.
6. `POST /_ref/runs/{run_id}/cancel` requires an owner session (missing/invalid session is rejected before the handler) and returns 202/404/409 for the three typed outcomes.
7. `cancel_run` appears in the owner-agent control catalog as a run-scoped, non-destructive action distinct from `run_connection`, `revoke_connection`, and `delete_connection`.

## Residual risks

- Live verification against the active ChatGPT/Amazon runs is owner-only and deferred. The active Amazon run MUST be left untouched until deploy; the route and tests prove the mechanism locally with stub connectors and an injected `runConnectorImpl`.
- The owner-agent bearer (`/v1/owner/...`) cancellation route is not implemented in this tranche; only the owner-session reference route ships. The catalog advertises the action for discovery.
