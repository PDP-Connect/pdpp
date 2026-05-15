## 1. Confirm Current Gap

- [x] Inspect current OpenSpec, docs, tests, Docker entrypoint, server startup,
  controller, scheduler, and schedule routes.
- [x] Confirm current Docker/server startup persists and displays schedules but
  does not start an active scheduler loop.
- [x] Identify the smallest safe wiring boundary.

## 2. Scheduler Manager

- [x] Add a server-owned scheduler manager that creates `createScheduler(...)`
  from persisted enabled schedules after AS/RS loopback URLs are known.
- [x] Reuse controller/runtime helpers for connector path resolution, owner
  token issuance, connector state, needs-human state, and active-run protection.
- [x] Refresh or restart the live scheduler manager when owner schedule
  mutations change the persisted schedule set.
- [x] Stop the scheduler manager during graceful shutdown before connector drain
  waits for active runs.

## 3. Validation

- [x] Add an integration test proving an enabled persisted schedule triggers an
  automatic run after server startup.
- [x] Add regression coverage proving paused/deleted schedules do not trigger
  automatic runs.
- [x] Add regression coverage proving scheduler startup honors persisted
  `last_run_time` instead of bypassing the configured interval.
- [x] Add shutdown coverage proving `stop()` suppresses retry/backoff launches.
- [x] Add or document a Docker/Compose smoke harness for enabled schedule
  execution in the reference service.

## 4. Acceptance Checks

- [x] Run `node --test --test-force-exit reference-implementation/test/scheduler.test.js`.
- [x] Run the schedule lifecycle/control-plane tests that cover `_ref` schedule
  mutations.
- [x] Run any new scheduler-manager/server-startup tests.
- [x] Run `openspec validate wire-reference-scheduler-loop --strict`.
