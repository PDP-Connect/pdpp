## 1. Runtime

- [x] 1.1 Persist direct scheduled attempt liveness via the existing scheduler
      active-run store after `run.started`.
- [x] 1.2 Clear the persisted liveness row when the attempt settles, including
      failure and retry paths.

## 2. Validation

- [x] 2.1 Add a scheduler regression test proving the active-run row exists
      during a direct scheduled run and is cleared after terminal.
- [x] 2.2 Run the targeted runtime/scheduler tests.
- [x] 2.3 Validate the OpenSpec change.
