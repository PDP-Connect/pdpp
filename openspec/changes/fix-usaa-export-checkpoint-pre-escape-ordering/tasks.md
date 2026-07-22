## 1. Ordering fix

- [x] Thread `DriveExportOptions` into `openExportDialog` so it can call `captureExportCheckpoint` directly.
- [x] Capture the `dialog-not-open` checkpoint before the `Escape` keypress inside `openExportDialog`.
- [x] Remove the now-redundant post-return checkpoint call in `driveExport`.

## 2. Regression

- [x] Add a mutation-grade test proving checkpoint-before-Escape call order, verified to fail against the pre-fix code (capture at index 1, Escape at index 0) and pass against the fix.

## 3. Validation

- [x] Run focused USAA connector tests (`connectors/usaa/*.test.ts`): 184 tests, 183 pass, 1 pre-existing skip, 0 fail.
- [x] Run the broader Chase + USAA + USAA login/runtime + browser-surface-diagnostic suite: 417 tests, 413 pass, 4 pre-existing skips, 0 fail.
- [x] `tsc --noEmit` in `packages/polyfill-connectors`: clean.
- [x] `ultracite check` on touched files: clean (after one auto-format fix).
- [x] `git diff --check`: clean.
- [x] `openspec validate fix-usaa-export-checkpoint-pre-escape-ordering --strict`: valid. `openspec validate --all --strict`: 77 passed, 0 failed.
