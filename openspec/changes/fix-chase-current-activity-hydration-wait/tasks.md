# Tasks: Fix Chase current-activity hydration wait

## 1. Connector

- [x] 1.1 Add a Chase dashboard recent-activity row selector matching the parser
  target.
- [x] 1.2 Wait for that selector before reading dashboard HTML for
  `current_activity`.
- [x] 1.3 Preserve the existing bounded selector-diagnostic path when the row
  selector does not appear.

## 2. Tests

- [x] 2.1 Prove dashboard HTML is read after the recent-activity row wait
  succeeds.
- [x] 2.2 Prove timeout still reads HTML and returns `rowSurfaceReady: false`,
  allowing the existing `selectors_pending` branch to explain real drift.

## 3. Acceptance Checks

- [x] 3.1 Run Chase current-activity/parser tests.
- [x] 3.2 Run reference typecheck.
- [x] 3.3 Run `openspec validate fix-chase-current-activity-hydration-wait --strict`.
- [ ] 3.4 Deploy and verify a live Chase retry.
