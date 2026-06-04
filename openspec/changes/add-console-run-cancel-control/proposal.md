## Why

The reference control plane can cancel a single active run by `run_id` — `POST /_ref/runs/{run_id}/cancel` shipped with `add-owner-run-cancellation-control`, terminals the run as `run.cancelled` (owner-cancelled), is non-destructive, and preserves already-collected records, schedule, grants, and configuration. The owner-session reference plane serves it, and the owner-agent control catalog advertises `cancel_run`.

The operator console does **not** expose this. The run detail page (`/dashboard/runs/[runId]`) renders status and timeline only; there is no control that calls the cancel route. An owner watching a long-running or source-throttled run in the dashboard — for example the ChatGPT detail-gap loops that motivated the original cancellation control — has no in-product way to stop it, and must fall back to an out-of-band `curl` with an owner-session cookie. The design note for the cancellation control anticipated this surface explicitly: "Surface this in the dashboard with copy that says it stops the current run only." (`design-notes/owner-run-cancellation-control-surface-2026-06-02.md`.)

This is an operator-control parity gap: a non-destructive action the agent surface and reference plane both expose, but the human console does not.

## What Changes

- Render a **Cancel run** control on the run detail page (`/dashboard/runs/[runId]`), gated to render only while the run is active (no terminal event yet). A cancel against an already-terminal run returns `409 run_already_terminal`, so the control SHALL NOT appear for terminal runs.
- The control SHALL require explicit confirmation before issuing the cancel, and its copy SHALL state that it stops only the current run and preserves already-collected records, schedule, grants, and configuration — distinct from revoke (stop future collection) and delete (erase the past).
- Wire the control through the established run-action pattern: a client wrapper in `operator-runs.ts` (`cancelRun(runId)`, owner-session cookie attached by `fetchAs`), a `"use server"` action in the run detail `actions.ts` (`revalidatePath` of the run detail route), and a `useTransition` client component rendered in the run detail page.
- Surface the three typed outcomes honestly: `202` acknowledged ("cancellation requested — the run will stop shortly"), `404 no_active_run` and `409 run_already_terminal` as in-place messaging rather than a route error boundary (the run likely just reached terminal between render and click).
- No backend, route, runtime, controller, or owner-agent-catalog change. This change is console-surface only; it consumes the already-shipped reference-control route.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-surface-topology`: operator dashboard run-detail affordances — add an owner-visible, active-run-only **Cancel run** control that requests single-run cancellation over the existing owner-session reference route, with confirmation and run-scoped, non-destructive copy.

## Impact

- Affected code: `apps/console/src/app/dashboard/lib/operator-runs.ts` (new `cancelRun` client wrapper), `apps/console/src/app/dashboard/runs/[runId]/actions.ts` (new `"use server"` `cancelRunAction`), a new client component under `apps/console/src/app/dashboard/runs/[runId]/`, and `apps/console/src/app/dashboard/runs/[runId]/page.tsx` (render the control in `beforeTimeline`, gated on `active`).
- No protocol-semantics change. No backend or reference-control change. No new route. `/mcp` and `/v1` read semantics unchanged.
- Non-destructive: cancelling a run from the console preserves already-flushed records, sibling runs, grants, schedules, and the connection itself — identical to the route's existing guarantees.

## Out of scope / parity findings recorded separately

Two further owner-agent-control actions have no human-console equivalent: `revoke_connection` (stop future collection) and `delete_connection` (erase collected data). Both are **destructive** connection-scoped actions that the owner-agent-control-surface spec deliberately scopes to an owner-agent bearer over the REST control plane. Adding one-click destructive connection controls to the dashboard is a distinct product and safety decision (confirmation ceremony, ambiguity guards, irreversibility) and is intentionally NOT bundled into this non-destructive run-cancel change. See `design-notes/console-action-parity-findings-2026-06-03.md`.
