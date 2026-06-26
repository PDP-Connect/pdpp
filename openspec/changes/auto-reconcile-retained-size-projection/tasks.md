## 1. Spec

- [x] 1.1 Add an OpenSpec change for bounded retained-size auto-reconcile and owner-safe stale copy.
- [x] 1.2 Validate the change with strict OpenSpec checks.

## 2. Implementation

- [x] 2.1 Invoke retained-size reconcile automatically on stale/failed retained-size dataset summary reads.
- [x] 2.2 Add an in-process cooldown after read-path reconcile failure.
- [x] 2.3 Preserve stale/failed projection metadata when reconcile fails.
- [x] 2.4 Replace dashboard stale/failure hero body text with concise owner-safe copy.

## 3. Regression Tests

- [x] 3.1 Cover global-only dirty retained-size metadata with clean stream/connection rows.
- [x] 3.2 Cover dirty row reconcile success from the dataset summary read.
- [x] 3.3 Cover reconcile failure returning stale/failed metadata and not retrying on the immediate next read.
- [x] 3.4 Cover dashboard copy excluding raw internal reasons.

## 4. Acceptance Checks

- [x] 4.1 Run targeted retained-size and route tests.
- [x] 4.2 Run targeted standing dashboard view-model tests.
- [x] 4.3 Run `openspec validate auto-reconcile-retained-size-projection --strict`.
