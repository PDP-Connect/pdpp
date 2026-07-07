## 1. Runner Behavior

- [x] 1.1 Add dead-letter error-class filtering to local outbox requeue.
- [x] 1.2 Requeue transient local-device request dead letters before pre-scan drain.
- [x] 1.3 Preserve terminal dead-letter behavior.

## 2. CLI Correctness

- [x] 2.1 Fix recovery/run summary open-work math so retrying rows are not double-counted.
- [x] 2.2 Handle closed stdout pipes without an unhandled process crash.

## 3. Validation

- [x] 3.1 Add tests for transient auto-recovery and terminal dead-letter preservation.
- [x] 3.2 Add tests for recovery-note count math and closed-pipe handling if practical.
- [x] 3.3 Run OpenSpec validation and targeted package tests.
