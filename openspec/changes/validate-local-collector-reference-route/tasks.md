## 1. Runner Startup

- [x] 1.1 Add a fail-fast reference-route precondition before local outbox lease recovery/drain.
- [x] 1.2 Preserve existing post-startup outbox recovery and corrective heartbeat behavior.

## 2. Local Doctor

- [x] 2.1 Add a bounded, redacted reference-route diagnostic for configured local collectors.
- [x] 2.2 Surface route failures distinctly from local outbox dead letters.

## 3. Validation

- [x] 3.1 Add tests proving a bad reference route does not mutate pending local work.
- [x] 3.2 Add tests for `doctor` route `ok`, `fail`, and `unknown` outputs.
- [x] 3.3 Run OpenSpec validation and targeted package tests.
