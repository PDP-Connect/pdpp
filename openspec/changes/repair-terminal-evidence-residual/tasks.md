## 1. Implementation

- [x] 1.1 Add opt-in immediate execution to the shared sweep timer.
- [x] 1.2 Launch the bounded startup walker before arming periodic maintenance.
- [x] 1.3 Remove the competing immediate connector-maintenance timer tick while preserving cursor/fence and cadence.

## 2. Verification

- [x] 2.1 Add deterministic production-wiring regressions for startup ownership, stale fully-evidenced repair, known recovery, failed repair, read-only reads, timer lifecycle, rejection, and overlap. The startup-order regression uses `startServer`'s injected timer constructor and real folded evidence; a temporary production-order reversion makes it fail with a zero-round walk.
- [x] 2.2 Run focused tests, attempted typecheck, Ultracite, OpenSpec validation, and diff review (full typecheck remains blocked only by the pre-existing test-only error at `test/controller-recovery-continuation-automation-policy.test.ts:118`).
