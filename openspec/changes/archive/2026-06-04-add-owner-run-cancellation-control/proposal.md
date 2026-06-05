## Why

The reference control plane can start a connector run and answer its pending interactions, but it has no first-class way to stop an already-running connector after the interaction phase. On 2026-06-02 a long-running ChatGPT run had to be stopped by killing the connector child process inside the container. That worked, but it produced a generic `run.failed` / `connector_exit_without_done` terminal event instead of an intentional cancellation, and the only coarser alternatives — restarting the server or revoking the connection — would have killed unrelated runs or destroyed configuration.

Operators need to cancel a single active run, scoped to one `run_id`, without restarting the reference server, without affecting sibling connector runs, and without erasing already-collected records or configuration. The terminal event must preserve owner-cancel intent so the timeline distinguishes a deliberate stop from a connector crash. See `design-notes/owner-run-cancellation-control-surface-2026-06-02.md`.

## What Changes

- Add an owner-only `POST /_ref/runs/{run_id}/cancel` reference-control route that requests cancellation of a single active controller-managed run.
- Add a controller `cancelRun(runId)` primitive that signals only the targeted run's in-flight runtime task and returns a typed result for no-active-run, already-terminal, and not-owner-authorized.
- Thread an `AbortSignal` into `runConnector` so the runtime can cooperatively terminate the connector child for the cancelled run using the existing graceful-then-`SIGKILL` escalation, while leaving other runs untouched.
- Emit a non-terminal `run.cancel_requested` audit event when the owner requests cancellation, and resolve the run to a terminal `run.cancelled` event that preserves the owner-cancel reason (graceful vs. forced) instead of `connector_exit_without_done`.
- Clear the `controller_active_runs` row for only the cancelled run and preserve checkpoint semantics: already-flushed records remain; staged cursor state is NOT committed on cancel.
- Surface `cancel_run` in the owner-agent control catalog as a non-destructive, run-scoped action distinct from `run_connection`, `revoke_connection`, and `delete_connection`.

## Capabilities

### Modified Capabilities

- `reference-implementation-runtime`: The controller SHALL expose an owner-only single-run cancellation control; the runtime SHALL cooperatively terminate the targeted connector child, emit `run.cancel_requested` and a terminal `run.cancelled` event that preserves owner-cancel intent, and SHALL NOT commit staged state on cancel.
- `reference-owner-agent-control-surface`: Add `cancel_run` as a typed, run-scoped, audited owner control action distinct from connection run/revoke/delete.

## Impact

- Affected APIs: owner reference-control routes (`/_ref/runs/{run_id}/cancel`); owner-agent control catalog (`cancel_run` action). No public/grant-scoped surface changes; `/mcp` and `/v1` read semantics are unchanged.
- Affected code: `reference-implementation/runtime/controller.ts`, `reference-implementation/runtime/index.js`, a new owner-session route module under `reference-implementation/server/routes/`, controller/runtime tests.
- No protocol-semantics change. This is reference/operator control only.
- Records already flushed before cancel are preserved; no records, sibling runs, grants, schedules, or connections are deleted.
