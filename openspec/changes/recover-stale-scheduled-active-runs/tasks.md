## 1. Runtime

- [x] 1.1 Add a scheduler direct-run wall-clock budget.
- [x] 1.2 Thread a scheduler-owned `AbortSignal` into `runConnector`.
- [x] 1.3 Convert budget expiry into a terminal failed scheduler record with `run_timed_out`.
- [x] 1.4 Preserve active-run cleanup in all paths.

## 2. Tests

- [x] 2.1 Add a focused scheduler test for timeout terminal failure and active-row cleanup.
- [x] 2.2 Add a regression test proving timeout wins over a late connector `DONE` during shutdown.
- [x] 2.3 Run existing scheduler/control tests affected by active-run lifecycle.

## 3. Live Closeout

- [ ] 3.1 Deploy the fix.
- [ ] 3.2 Verify live active runs drain or terminal instead of remaining stuck.
- [ ] 3.3 Verify the source attention list reflects only current owner actions, actionable reviews, or real connector/runtime failures.
