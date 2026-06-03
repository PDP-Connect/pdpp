## Why

The local collector's `status`/`doctor` CLI already reports raw outbox counts (pending, retrying, leased, dead-letter, stale leases) and a coarse `ok/warning/critical` severity, but it never names the single situation the lane is in. An operator or agent reading the JSON has to infer "is this draining, just waiting on backoff, crashed mid-drain, or stuck on coverage?" from a count tuple. The hardest case to read is coverage: a fully drained lane that has collected real records but never carried a `coverage_diagnostics` record is the exact device-local shape behind the dashboard's stuck `SourceCoverageComplete: coverage_unknown` — yet the local surface gave no signal for it at all.

## What Changes

- Add a single mutually-exclusive lifecycle state — `healthy_idle`, `draining`, `retryable_backlog`, `dead_letter`, `stale_lease`, `coverage_missing` — derived from the durable outbox alone, and surface it on both `status` and `doctor`.
- Detect the device-local "coverage missing" condition by scanning the durable outbox for whether the lane has ever carried a `coverage_diagnostics` record, distinguishing a lane that collected records but no coverage diagnostic from an empty lane that has nothing to miss.
- Add a `coverage` block (`observed`, `record_batches`) as the evidence behind that verdict, a `doctor` `coverage_diagnostics` check, and per-condition remediation hints for the coverage and stale-lease cases.
- Detect coverage observation from a payload-light observed-stream index (schema v2 sidecar table) maintained on enqueue, so `status`/`doctor` stay fast on a multi-gigabyte retained outbox instead of reparsing every payload; a pre-index outbox backfills lazily and bounded, reporting `observed: null` (never `coverage_missing`) when its unindexed backlog exceeds the scan budget.
- Document the published-vs-dev deployment posture so an operator host pins a published package/version rather than accidentally running a repo `dist/` override, and never uses the placeholder `latest` (`0.0.0`) dist-tag.
- Keep the surface redaction-safe (counts/state only; never payloads, paths, or tokens) and connection-scoped.

## Capabilities

### New Capabilities

### Modified Capabilities

- `local-collector-durable-work`: connection-scoped health SHALL name a single derived lifecycle state, and SHALL distinguish a drained-but-coverage-missing lane from a healthy idle one.

### Removed Capabilities

## Impact

- Affected runtime: `packages/polyfill-connectors/src/collector-runner.ts` (new `deriveLocalCollectorLifecycleState` + lifecycle-state enum), `packages/polyfill-connectors/src/local-device-outbox.ts` (read-only `hasObservedStream` / `countRecordBatches` backed by the schema-v2 `local_device_observed_stream` index, maintained on enqueue, with a bounded legacy backfill), `packages/polyfill-connectors/src/runner/index.ts` and `packages/local-collector/src/runner.ts` (re-exports), `packages/local-collector/bin/pdpp-local-collector.ts` (`lifecycle_state` + `coverage` on `status`/`doctor`).
- Affected docs: `docs/operator/local-collector-runbook.md`, `docs/local-collector.md` (including the published-vs-dev deployment posture).
- Affected tests: `packages/local-collector/test/runner.test.js`, `packages/polyfill-connectors/src/local-device-outbox.test.ts`, `packages/polyfill-connectors/src/collector-runner.test.ts`.
- Outbox schema bumps to v2 to add the additive `local_device_observed_stream` sidecar index. The `local_device_outbox` row shape is unchanged, and the index is populated lazily/bounded, so opening an existing (including multi-gigabyte legacy) outbox does no payload work. No change to the heartbeat wire contract, the device-exporter storage shape, or any public read API.
