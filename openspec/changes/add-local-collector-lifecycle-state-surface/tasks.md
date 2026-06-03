# Tasks — Local collector lifecycle-state surface

## 1. Derivation and outbox queries

- [x] 1.1 Add `deriveLocalCollectorLifecycleState` + `LOCAL_COLLECTOR_LIFECYCLE_STATES` enum and `LocalCollectorLifecycleInput` type in `collector-runner.ts`.
- [x] 1.2 Add read-only `hasObservedStream` (`boolean | null`) and `countRecordBatches` to `LocalDeviceOutbox`, backed by a payload-light index; exclude dead-letter rows.
- [x] 1.3 Re-export the derivation/enum/types through the runner slice and `@pdpp/local-collector`'s `src/runner.ts`.

## 1a. Payload-light, bounded coverage index (perf construction)

- [x] 1a.1 Add the schema-v2 `local_device_observed_stream (outbox_id, source_instance_id, stream)` sidecar index; bump `CURRENT_SCHEMA_VERSION` to 2.
- [x] 1a.2 Maintain the index on every `record_batch` `enqueue()` from the in-memory payload (one row per distinct stream; sentinel for empty-records batches).
- [x] 1a.3 Answer `hasObservedStream` from the index joined to live status (no `payload_json` scan); back-fill legacy v1 rows lazily, per-lane, bounded by a fixed scan budget; return `null` when the unindexed backlog exceeds the budget.

## 2. CLI surface

- [x] 2.1 Add `lifecycle_state` and a `coverage` block (`observed`, `record_batches`) to `status`/`doctor` JSON.
- [x] 2.2 Add a `coverage_diagnostics` doctor check and per-condition remediation hints for the coverage and stale-lease cases.
- [x] 2.3 Keep the surface connection-scoped and redaction-safe (counts/state only).

## 3. Docs

- [x] 3.1 Document the lifecycle-state table and `coverage` block in `docs/operator/local-collector-runbook.md`.
- [x] 3.2 Add persistent-state/scratch guidance (no raw `/tmp` on tmpfs hosts) to `docs/local-collector.md` and reference it from the runbook.
- [x] 3.3 Document the bounded, payload-light coverage detection and the `observed: null` legacy case in the runbook.
- [x] 3.4 Add the published-vs-dev deployment posture to `docs/local-collector.md` (pin a published version, never repo `dist/`, never the `0.0.0` `latest` tag) and reference it from the runbook prerequisites.

## 4. Tests

- [x] 4.1 Unit-test each of the six lifecycle states through the CLI surface.
- [x] 4.2 Unit-test `hasObservedStream`/`countRecordBatches` (survives drain, ignores dead-letter, source-scoped).
- [x] 4.3 Assert no payloads/ids/tokens leak through `status`/`doctor`.
- [x] 4.4 Unit-test the index construction: new enqueues populate the index; the probe answers without reparsing payloads (blanked `payload_json`); legacy backfill within budget answers exactly; over-budget legacy backlog returns `observed: null` and stays bounded; the CLI surfaces that as `healthy_idle` with `coverage.observed: null`.

## Acceptance checks

- `cd packages/local-collector && node --test --import tsx 'test/*.test.js'` — green.
- `cd packages/polyfill-connectors && node --test --import tsx 'src/collector-runner.test.ts' 'src/local-device-outbox.test.ts'` — green.
- `npx tsc -p packages/local-collector/tsconfig.build.json --noEmit` — clean.
- `cd packages/polyfill-connectors && npx tsc -p tsconfig.runner.json --noEmit` — clean (no-Playwright boundary holds).
