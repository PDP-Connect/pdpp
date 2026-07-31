## 1. Terminal authority and phase order

- [x] Remove terminal checkpoint lag from generic repair classification.
- [x] Fold existing bounded-page participants before generic repairs.
- [x] Preserve cold-page missing-row repair followed by a bounded fold.

## 2. Evidence and regressions

- [x] Add aggregate fold progress receipts and zero-progress state.
- [x] Add exact 25-row SQLite starvation, unrelated-page, and restart/resume tests.
- [x] Add real disposable PostgreSQL mutation parity for the 25-row starvation shape.
- [x] Bound cooperative 1 ms cold repair and 2,001-event fold work without an invented phase timeout.
- [x] Gate every participant checkpoint CAS by the same cooperative deadline and prove delayed-write resumption.

## 3. Acceptance checks

- [x] Run focused SQLite and dedicated PostgreSQL suites.
- [x] Run reference-implementation typecheck.
- [x] Run repository static, OpenSpec, accounting, policy, and full relevant gates.
