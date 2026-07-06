# Tasks

## 1. Spec

- [x] 1.1 Create OpenSpec proposal, design, and requirement deltas.
- [x] 1.2 Validate with `openspec validate extend-owner-run-cancellation-to-scheduler --strict`.

## 2. Runtime and route

- [x] 2.1 Add a scheduler-direct run cancellation registration seam.
- [x] 2.2 Register and unregister direct scheduled runs by `run_id`.
- [x] 2.3 Make the owner run-cancel route fall back to scheduler cancellation after controller `no_active_run`.
- [x] 2.4 Preserve `cancelled` scheduler run status and mark owner-cancel terminal reasons non-retryable.

## 3. Tests

- [x] 3.1 Add direct scheduler cancellation test covering route 202, spine `run.cancelled`, and scheduler history `cancelled`.
- [x] 3.2 Update existing scheduler cancelled-status expectations.
- [x] 3.3 Run targeted scheduler/control tests and `git diff --check`.
