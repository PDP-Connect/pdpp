# Tasks: bound version-stats default reads

## 1. OpenSpec

- [x] 1.1 Add an OpenSpec change explaining the bounded-default advisory model.
- [x] 1.2 Validate the change with `openspec validate bound-version-stats-default-read --strict`.

## 2. Console hot path

- [x] 2.1 Remove the live version-stats fetch from `/dashboard/records`.
- [x] 2.2 Keep demo-only churn advisory fixtures available for screenshots.
- [x] 2.3 Update the page-performance invariant for the current shell component.

## 3. Server default route

- [x] 3.1 Make unfiltered version-stats always use the bounded projection path.
- [x] 3.2 Do not include dirty projection rows in the unfiltered ground-truth candidate set.
- [x] 3.3 Preserve scoped ground-truth diagnostics for explicit filters.

## 4. Tests

- [x] 4.1 Update record-version-stats tests for bounded dirty-default behavior.
- [x] 4.2 Add/keep a scoped diagnostic test proving exact ground truth remains available.
- [x] 4.3 Run the Sources page performance invariant test.
- [x] 4.4 Run the version-stats test suite.

## 5. Validation

- [x] 5.1 Run `openspec validate bound-version-stats-default-read --strict`.
- [x] 5.2 Run `openspec validate --all --strict`.
- [x] 5.3 Run relevant type/check commands or document why they were not run.
