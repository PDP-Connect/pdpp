# Owner Run Cancellation Control Surface

Status: decided-promote
Owner: RI owner
Created: 2026-06-02
Updated: 2026-06-02
Related: add-owner-agent-control-surface, add-run-interaction-streaming-companion, reference-implementation runtime/controller

## Question

Should the reference implementation expose a first-class owner-only control to cancel an active connector run by `run_id` or `connection_id`?

## Context

On 2026-06-02 the ChatGPT connector run `run_1780341172584` needed to be stopped so a bounded request-policy A/B probe could run without contaminating the source rate bucket. The reference deployment had:

- owner run start and run timeline surfaces;
- an interaction response route that can mark a pending manual interaction `cancelled`;
- active-run persistence in `controller_active_runs`;
- terminal run events including `run.cancelled` in the spine model.

It did not have an obvious owner-control route that cancels an already-running connector after the manual interaction phase has completed. The operator had to terminate the ChatGPT connector child process directly inside the reference container. That stopped only the ChatGPT child, left the Amazon run active, and cleared the ChatGPT active-run row after the controller observed child exit. The resulting terminal event was `run.failed` with reason `connector_exit_without_done`, not an intentional owner cancellation.

## Stakes

This is an operator-control and recoverability gap:

- Operators need to stop long-running or source-throttled connector runs without restarting the whole reference server or killing unrelated connector runs.
- The control should preserve checkpoint semantics and audit evidence instead of forcing a process-kill failure shape.
- Cancellation should be scoped to a single active run or connection and must not erase collected records, sibling connections, grants, or schedules.
- The dashboard and CLI need an honest stop action that distinguishes "cancel this run" from "revoke/delete this connection" and from "dismiss this browser stream".

## Current Leaning

Promote to an OpenSpec-backed reference-control change.

The likely ideal shape:

- Add owner-only `POST /_ref/runs/:runId/cancel` and owner-agent equivalent where appropriate.
- Resolve a typed result when no active run exists, when the run is already terminal, or when the caller is not owner-authorized.
- Signal the in-memory controller task for that run and emit `run.cancel_requested`.
- Give the connector/runtime a short graceful window to emit `DONE(cancelled)`.
- If the child ignores graceful termination, terminate the child process and emit a terminal event that preserves the owner-cancel reason rather than generic `connector_exit_without_done`.
- Clear `controller_active_runs` for only the cancelled run.
- Preserve already-flushed records under the checkpointed streaming model and do not commit staged cursor state unless the runtime has explicit safe-cancel semantics.
- Surface this in the dashboard with copy that says it stops the current run only.

Open questions:

- Whether intentional owner cancellation should always terminal as `run.cancelled`, or whether hard-kill-after-timeout should be `run.failed` with `owner_cancel_forced` while still preserving the cancel request.
- Whether a connector can expose a cooperative cancel hook beyond process signals.
- Whether staged state can ever be safely committed on owner cancel, or whether cancellation should consistently leave state uncommitted.

## Promotion Trigger

Promote before implementing any owner-visible cancel button, CLI command, REST route, or runtime/controller cancellation behavior.

## Decision Log

- 2026-06-02: Captured after stopping `run_1780341172584` by killing only the ChatGPT connector child. The workaround succeeded operationally but produced a generic failure terminal event and confirmed the missing first-class control.
