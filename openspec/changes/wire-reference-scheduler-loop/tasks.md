## 1. Confirm Current Gap

- [x] Inspect current OpenSpec, docs, tests, Docker entrypoint, server startup,
  controller, scheduler, and schedule routes.
- [x] Confirm current Docker/server startup persists and displays schedules but
  does not start an active scheduler loop.
- [x] Identify the smallest safe wiring boundary.

## 2. Scheduler Manager

- [ ] Add a server-owned scheduler manager that creates `createScheduler(...)`
  from persisted enabled schedules after AS/RS loopback URLs are known.
- [ ] Reuse controller/runtime helpers for connector path resolution, owner
  token issuance, connector state, needs-human state, and active-run protection.
- [ ] Refresh or restart the live scheduler manager when owner schedule
  mutations change the persisted schedule set.
- [ ] Stop the scheduler manager during graceful shutdown before connector drain
  waits for active runs.

## 3. Validation

- [ ] Add an integration test proving an enabled persisted schedule triggers an
  automatic run after server startup.
- [ ] Add regression coverage proving paused/deleted schedules do not trigger
  automatic runs.
- [ ] Add shutdown coverage proving `stop()` suppresses retry/backoff launches.
- [ ] Add or document a Docker/Compose smoke harness for enabled schedule
  execution in the reference service.

## 4. Acceptance Checks

- [ ] Run `node --test --test-force-exit reference-implementation/test/scheduler.test.js`.
- [ ] Run the schedule lifecycle/control-plane tests that cover `_ref` schedule
  mutations.
- [ ] Run any new scheduler-manager/server-startup tests.
- [ ] Run `openspec validate wire-reference-scheduler-loop --strict`.
