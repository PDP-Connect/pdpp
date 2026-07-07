# Tasks

## 1. Spec

- [x] 1.1 Create OpenSpec proposal, design, and requirement delta.
- [x] 1.2 Validate with `openspec validate render-browser-surface-deferrals --strict`.

## 2. Implementation

- [x] 2.1 Map browser-surface `deferred` run handles to a neutral terminal display state.
- [x] 2.2 Render browser stream deferrals with capacity/backpressure copy instead of failure copy.
- [x] 2.3 Keep true browser setup failures mapped to failed.

## 3. Tests

- [x] 3.1 Add run-detail mapping coverage for `deferred`.
- [x] 3.2 Add stream fallback coverage for deferred browser-surface runs.
- [x] 3.3 Run targeted tests, OpenSpec validation, and `git diff --check`.
