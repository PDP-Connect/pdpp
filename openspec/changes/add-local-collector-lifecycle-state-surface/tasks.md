# Tasks — Local collector lifecycle-state surface

## 1. Derivation and outbox queries

- [x] 1.1 Add `deriveLocalCollectorLifecycleState` + `LOCAL_COLLECTOR_LIFECYCLE_STATES` enum and `LocalCollectorLifecycleInput` type in `collector-runner.ts`.
- [x] 1.2 Add read-only `hasObservedStream` and `countRecordBatches` to `LocalDeviceOutbox` (json_each over `$.records[*].stream`; exclude dead-letter rows).
- [x] 1.3 Re-export the derivation/enum/types through the runner slice and `@pdpp/local-collector`'s `src/runner.ts`.

## 2. CLI surface

- [x] 2.1 Add `lifecycle_state` and a `coverage` block (`observed`, `record_batches`) to `status`/`doctor` JSON.
- [x] 2.2 Add a `coverage_diagnostics` doctor check and per-condition remediation hints for the coverage and stale-lease cases.
- [x] 2.3 Keep the surface connection-scoped and redaction-safe (counts/state only).

## 3. Docs

- [x] 3.1 Document the lifecycle-state table and `coverage` block in `docs/operator/local-collector-runbook.md`.
- [x] 3.2 Add persistent-state/scratch guidance (no raw `/tmp` on tmpfs hosts) to `docs/local-collector.md` and reference it from the runbook.

## 4. Tests

- [x] 4.1 Unit-test each of the six lifecycle states through the CLI surface.
- [x] 4.2 Unit-test `hasObservedStream`/`countRecordBatches` (survives drain, ignores dead-letter, source-scoped).
- [x] 4.3 Assert no payloads/ids/tokens leak through `status`/`doctor`.

## Acceptance checks

- `cd packages/local-collector && node --test --import tsx 'test/*.test.js'` — green.
- `cd packages/polyfill-connectors && node --test --import tsx 'src/collector-runner.test.ts' 'src/local-device-outbox.test.ts'` — green.
- `npx tsc -p packages/local-collector/tsconfig.build.json --noEmit` — clean.
- `cd packages/polyfill-connectors && npx tsc -p tsconfig.runner.json --noEmit` — clean (no-Playwright boundary holds).
