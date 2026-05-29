## Context

Current behavior is split:

- `reference-implementation/runtime/scheduler.ts` is an active scheduler loop
  with `start()` and `stop()`, retry/backoff policy, overlap prevention,
  persisted run history, and needs-human suppression.
- `reference-implementation/runtime/controller.ts` owns schedule persistence,
  `_ref` projections, manual `runNow`, active controller-managed runs, connector
  path resolution, and human-attention state.
- `reference-implementation/server/index.js` creates a controller during normal
  server startup, then Docker runs that same entrypoint via
  `CMD ["node", "reference-implementation/server/index.js"]`.

The gap is that server startup never constructs `createScheduler(...)` from
persisted `connector_schedules`, never calls `scheduler.start()`, and never
stores a scheduler handle for shutdown. A comment in `createController` says
`runtime` and `scheduler` options are hooks for a later slice and are not read
yet, confirming the intended bridge was deferred.

## Design

Add a server-owned scheduler manager that starts only for long-lived reference
server processes. It should run after:

- database and storage initialization complete
- `controller.booted` and orphan reconciliation complete
- the AS and RS listeners are bound
- `runtimeContext.referenceBaseUrl` and `runtimeContext.rsUrl` have loopback
  URLs suitable for server-side connector children

The manager should:

- load persisted schedules through the existing scheduler store/controller seam
- ignore deleted or disabled schedules
- resolve each connector manifest and runnable connector path with the same
  rules as manual `runNow`
- use `scheduled_refresh` as the run priority class
- issue runtime owner tokens through the controller-owned owner-device flow
- use the same connector state store as manual/runtime runs
- share needs-human state with schedule projections so dashboard state matches
  automatic behavior
- persist scheduler run history and last-run times through the existing
  scheduler store
- expose a stop hook that prevents new ticks/retries before graceful connector
  drain

Schedule mutations should update the live loop without requiring a process
restart. The smallest acceptable implementation can restart the in-process
scheduler manager after schedule create/update/pause/resume/delete if that is
simpler than per-schedule mutation wiring, provided it does not overlap active
runs or drop persisted state.

## Alternatives Considered

- Leave schedules display-only. Rejected because existing OpenSpec and tests
  already describe an active scheduler; the dashboard's `automatic` state is
  misleading if nothing runs.
- Run a second scheduler process in Docker. Rejected for this tranche because it
  duplicates controller state and active-run coordination.
- Make Docker special. Rejected; Docker should exercise the same long-lived
  reference server lifecycle as local production-like startup.

## Acceptance Checks

- Creating an enabled schedule in a long-lived reference server causes an
  automatic connector run without a manual `run now`.
- Pausing or deleting a schedule prevents later automatic runs.
- Restarting the reference server preserves schedules and resumes enabled
  schedule execution.
- A schedule tick does not launch before AS/RS loopback URLs are populated.
- Shutdown calls scheduler `stop()` and does not launch a retry after stop.
- A Docker/Compose smoke path demonstrates that enabled schedules execute in
  the reference service when credentials/imports are available.
