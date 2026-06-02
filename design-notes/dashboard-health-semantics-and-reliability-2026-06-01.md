# Dashboard Health Semantics And Reliability

Status: sprint-needed
Owner: RI owner
Created: 2026-06-01
Updated: 2026-06-01
Related: `openspec/changes/add-connector-adaptive-lanes`, `openspec/specs/reference-connector-instances/spec.md`, `design-notes/connection-lifecycle-and-local-collector-recovery-2026-06-01.md`

## Question

How should the reference console present connection health, outbox state, gaps, slow pages, and run-start failures so owners can tell what happened and what to do next?

## Context

Owner feedback on 2026-06-01 identified several dashboard failures:

- Most connections show `Outbox · unknown`, while only Claude Code local collectors show `Outbox · stalled`. If outbox is only meaningful for local-collector lanes, `unknown` is the wrong default for other connector classes.
- `Outbox · active` is not visually color-coded, while stalled state is visually salient.
- `Coverage · terminal gap` is unclear. It does not say what terminated, whether current records are safe, or which action can recover coverage.
- `/dashboard/records` and some other dashboard pages load too slowly and have no route-level Next.js `loading.tsx` state or intentional loading animation.
- `Sync now` can crash into a generic dashboard-level "Something went wrong" instead of preserving connection/run context and explaining whether the request reached the reference server.
- A Gmail run appears to have failed unexpectedly: `run_1780367430533`.
- A Reddit sync triggered a page crash to the same generic error boundary.

The current code map confirms at least one structural issue: `apps/console/src/app/dashboard/error.tsx` is the only dashboard loading/error boundary discovered under `dashboard/`, and no dashboard route-level `loading.tsx` exists.

## Stakes

The health surface is part of the SLVP construction. Owners should not need private implementation memory to interpret `unknown`, `terminal gap`, or a generic crash. If the system knows only that evidence is unavailable, it should say that. If a state applies only to local collectors, it should not appear as a mysterious unknown on API/browser connectors. If a run-start request fails, the console should keep the owner on the same connection context and show an actionable recovery path.

## Current Leaning

The dashboard should separate axes by applicability:

- Local outbox: show only for local/device-backed connectors, with clear states such as `queued`, `active`, `stalled`, or `not applicable`.
- Coverage: distinguish `unknown evidence`, `retryable gap`, and `terminal gap`, and pair each with cause/time/action.
- Run start: use local error handling around `Sync now` instead of letting network/server failures fall through to the route error boundary.
- Slow routes: add route-level `loading.tsx` for records/runs surfaces and keep the loading UI lightweight, using existing console visual language.

`Outbox · unknown` should be treated as a defect when it appears for connectors where no outbox should exist, and as insufficient copy when it appears for local collectors whose outbox evidence failed to load.

## Promotion Trigger

Promote into OpenSpec before changing durable health-state contracts, adding new health states, or changing how the reference server computes coverage/outbox axes. Pure console rendering, loading states, and safer client-side error handling can land as reference cleanup if they preserve existing backend semantics.

## Decision Log

- 2026-06-01: Captured owner feedback that outbox applicability, active/stalled color semantics, terminal coverage gap copy, route-level loading states, and `Sync now` crash handling are priority owner-facing RI issues.
- 2026-06-01: Read-only code map found a single dashboard-level `error.tsx` and no dashboard route-level `loading.tsx` files.
