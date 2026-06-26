## 1. Dashboard Summary Semantics

- [x] 1.1 Add an `advisoryOwnerActions` bucket to the Standing Overview view-model.
- [x] 1.2 Update hero precedence so owner-runnable advisory actions suppress calm/all-clear copy without rendering urgent attention copy.
- [x] 1.3 Add view-model tests for Amazon-style `retry_gap` and Reddit-style `refresh_now` advisory owner actions.

## 2. Source List Cues

- [x] 2.1 Surface a compact source-list cue for owner-runnable advisory actions.
- [x] 2.2 Keep maintainer-only actions visibly distinct and non-owner-runnable.
- [x] 2.3 Add source-list view-model/render tests for owner-runnable and maintainer-only action rows.

## 3. Test Hygiene And Copy Invariants

- [x] 3.1 Rewrite or remove stale `dashboard-summary-ux.test.ts` assertions that target the old dashboard home shape.
- [x] 3.2 Add active Standing Overview tests for stale/failed projection owner-safe copy.
- [x] 3.3 Add copy invariants that primary owner dashboard copy excludes `projection`, `rebuild`, `bulk write`, `unknown connection`, and `SQL`.

## 4. Acceptance Checks

- [x] 4.1 Run `openspec validate surface-dashboard-advisory-actions --strict`.
- [x] 4.2 Run the targeted dashboard/Standing Overview tests.
- [x] 4.3 Run relevant console typecheck or package test command.
