# Proposal: surface-run-handle-resolvability

## Why

The vanished-run diagnosis (`tmp/workstreams/vanished-run-diagnosis-2026-06-10.md`,
run `run_1781118340000`) showed that a run which started, persisted both
lifecycle events, and failed terminally 452 ms after launch still *looked*
vanished to its observer. The contract break: the `run_id` returned by the
run-now 202 ack stops being resolvable the moment the run settles.

- `GET /_ref/runs/:runId` was not a route at all — polling the handle got
  Express's default unknown-route 404, indistinguishable from "run record
  lost".
- `controller_active_runs` is flight state only (inserted before the 202,
  deleted when the run settles), so a fast-failing run is gone from it by the
  first poll.
- The controller's launch catch path logged failures **without the run id**
  (`[controller] manual run failed for <connector>: <message>`), so even the
  one log line a launch failure produced was not greppable by run id.
- A throw between the 202 and the runtime's `run.started` emit (env/spawn
  prep) was swallowed entirely: 202 + run_id, zero spine events, no
  identifiable log line — the one true "phantom 202" window.

The existing `reference-implementation-runtime` requirement "Runtime SHALL
persist safe run timeline events" was *satisfied* by the incident (the
terminal event was durable and complete). What no spec requires today is
**run-handle resolvability**: nothing says a `run_id` returned by a control
surface must remain GET-resolvable afterwards.

## What Changes

- Add owner-session route `GET /_ref/runs/:runId`
  (`server/routes/ref-run-status.ts`) resolving any known run id to a status
  projection: active runs from the controller's in-process bookkeeping,
  finished runs from the run's terminal spine event (bounded `LIMIT 1`
  lookups: `getRunTerminalEvent` + `getRunStartedEvent` in `lib/spine.ts`),
  with typed terminal reason / bounded failure summary, started/completed
  timestamps, connector identity, and a link to the existing timeline route.
  Unknown ids get a typed `not_found` error envelope, never the transport
  default 404.
- Include `run_id` and `trace_id` in the controller's launch-failure swallow
  log (`runtime/controller.ts` run-now catch path).
- Close the phantom-202 window: the run-now catch path emits a typed terminal
  `run.failed` (`reason: launch_failed`) when the rejection left no terminal
  event on the spine (same terminal-existence guard the boot reconciler
  uses), so a launch crash before `run.started` still leaves the handle
  resolvable.
- Spec delta (`reference-implementation-runtime`): new requirement that every
  run identifier returned by a control surface SHALL remain resolvable to a
  status until and after the run reaches a terminal state.

## Impact

- Affected specs: `reference-implementation-runtime` (ADDED requirement).
- Affected code:
  - `reference-implementation/server/routes/ref-run-status.ts` (new route
    adapter) + mount in `server/index.js`.
  - `reference-implementation/lib/spine.ts`,
    `reference-implementation/lib/postgres-spine.js`,
    `reference-implementation/server/queries/spine/get-run-started-event.sql`,
    `get-run-terminal-event.sql`, `server/queries/index.ts` (bounded
    lifecycle-event lookups for both storage backends).
  - `reference-implementation/runtime/controller.ts`
    (`findActiveRunByRunId`, launch-catch log fields, typed `launch_failed`
    terminal emit).
- No public PDPP protocol surface changes; `/_ref` is reference/operator
  control. No new secret exposure: the route serves the same runtime-authored
  terminal-event fields the owner-session timeline route already serves.
