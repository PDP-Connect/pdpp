## 1. Implementation

- [x] Add a bounded scheduler-history query keyed by `connector_instance_id`.
- [x] Expose a semantic scheduler-store method for latest per-connection run history.
- [x] Use exact scheduler history in the connection-summary projection before legacy connector-wide fallback.
- [x] Add regression coverage for multi-account scheduler-history hydration.

## 2. Validation

- [x] `openspec validate use-connection-scoped-scheduler-history --strict`
- [x] `pnpm --dir reference-implementation exec node --test --import tsx test/ref-connectors-connection-projection.test.js test/scheduler-store-semantic-surface.test.js`
- [x] `pnpm --dir reference-implementation run typecheck`
- [x] `git diff --check`

## Notes

`pnpm --dir reference-implementation run check` is not clean on current main because of existing unrelated `ref-control.ts` and scheduler/runtime diagnostics. The touched behavior is covered by targeted tests and typecheck.
