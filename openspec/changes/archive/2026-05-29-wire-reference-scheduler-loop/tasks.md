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
- [x] Add regression coverage proving scheduler restart does not re-emit
  persisted back-off transition markers.
- [x] Add shutdown coverage proving `stop()` suppresses retry/backoff launches.
- [x] Add or document a Docker/Compose smoke harness for enabled schedule
  execution in the reference service.

## 4. Acceptance Checks

- [x] Run `node --test --test-force-exit reference-implementation/test/scheduler.test.js`.
- [x] Run the schedule lifecycle/control-plane tests that cover `_ref` schedule
  mutations.
- [x] Run any new scheduler-manager/server-startup tests.
- [x] Run `openspec validate wire-reference-scheduler-loop --strict`.

## 5. Restart-Safe Schedule Projection

- [x] Project `scheduler_run_history` + `scheduler_last_run_times` into
  `ScheduleApi.last_started_at`, `last_finished_at`, `last_successful_at`, and
  `last_error_code` when no in-memory active-run row exists, so an operator
  who restarts the reference server still sees honest last-run facts.
- [x] Compute `ScheduleApi.next_due_at` as `last_finished_at + interval_seconds`
  when an anchor exists, so the dashboard and `scheduler-doctor` can
  distinguish "ran but currently idle" from a genuinely never-fired schedule.
- [x] Read history once per `listSchedules()` / `getSchedule()` call and index
  in memory; no N+1 history queries.
- [x] Extend `scheduler-doctor`:
  - [x] refine `would_fire` to honor `next_due_at` (no false-positive "about
    to fire" for recently-completed schedules);
  - [x] redefine `never_ran` to require an absent last-run anchor, not just an
    absent active-run row;
  - [x] surface `IDLE` tag for enabled, manifest-eligible schedules whose
    next dispatch is in the future.
- [x] Cover with focused tests:
  - [x] controller projects history into schedule projection after restart
    (success + failure rows);
  - [x] doctor counts `never_ran` from the enriched projection, not from a
    cleared in-memory `last_started_at`;
  - [x] doctor's `would_fire` is false when `next_due_at` is still ahead;
  - [x] existing `NOSCHED`/`MANUAL` cross-reference behavior remains intact.
