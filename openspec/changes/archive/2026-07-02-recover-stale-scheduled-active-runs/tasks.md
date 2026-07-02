## 1. Runtime

- [x] 1.1 Add a scheduler direct-run progress watchdog.
- [x] 1.2 Thread a scheduler-owned `AbortSignal` into `runConnector`.
- [x] 1.3 Convert budget expiry into a terminal failed scheduler record with `run_timed_out`.
- [x] 1.4 Preserve active-run cleanup in all paths.
- [x] 1.5 Reset the scheduler watchdog on valid connector progress.
- [x] 1.6 Emit Slack `slackdump` archive-growth progress while the subprocess is running.

## 2. Tests

- [x] 2.1 Add a focused scheduler test for timeout terminal failure and active-row cleanup.
- [x] 2.2 Add a regression test proving timeout wins over a late connector `DONE` during shutdown.
- [x] 2.3 Add a regression test proving valid connector progress prevents timeout for a long direct run.
- [x] 2.4 Add a Slack subprocess progress test using a fake `slackdump` binary.
- [x] 2.5 Run existing scheduler/control tests affected by active-run lifecycle.

## 3. Live Closeout

- [x] 3.1 Deploy the fix.
- [x] 3.2 Verify live active runs drain or terminal instead of remaining stuck.
- [x] 3.3 Verify the source attention list reflects only current owner actions, actionable reviews, or real connector/runtime failures.
