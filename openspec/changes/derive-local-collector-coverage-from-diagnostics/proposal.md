## Why

A healthy, fully-drained local collector still projects `SourceCoverageComplete:coverage_unknown` on `/_ref/connectors`. The connection-health rollup derives the coverage axis only from spine run history (`mapCoverageAxis(lastRun, ...)`), but local-device collectors push records from a device outbox and never write a spine run, so `lastRun` is always `null` and the coverage axis can only ever be `unknown` for them. The owner sees an unknown/non-green coverage condition even after a successful host-local drain, with no honest statement of what (if anything) is missing.

A durable, honest coverage signal already exists and is unused by this rollup: local collectors emit `coverage_diagnostics` records (read by `listLocalCoverageDiagnostics` and summarized for the device-exporter diagnostics surface via `summarizeLocalCoverage`). These records classify each known store as collected / inventory-only / excluded / deferred / missing / unsupported / unaccounted. The `local-agent-collector-completeness` spec already forbids treating an empty outbox or declared-stream success as complete; the coverage diagnostics are the signal that proves completeness honestly.

## What Changes

- When the connection-health rollup has no run-derived coverage verdict (no spine run, no detail gaps, no contradiction) it SHALL derive the coverage axis from durable `coverage_diagnostics` records for that connection: every observed store accounted-for projects `complete`; any `unaccounted` store projects degrading `gaps`; no observed coverage records leaves the axis `unknown`.
- Run-derived coverage stays authoritative: when a spine run or gap evidence yields any non-`unknown` axis (`complete`, `partial`, `retryable_gap`, `terminal_gap`, an accepted-coverage label, or a contradiction), the local coverage diagnostics SHALL NOT override it. The diagnostics are a fallback for the local-collector case only.
- An empty or drained outbox SHALL NOT be treated as proof of complete coverage; only durable coverage evidence promotes the axis off `unknown`.
- The durable coverage signal SHALL actually be emitted by the local collector lifecycle: the published `@pdpp/local-collector` connector defaults SHALL request `coverage_diagnostics` so an unscoped run emits it, and a connector SHALL emit per-store coverage diagnostics (classifying absent stores `missing`) even when a requested content source is unreadable, rather than aborting with zero coverage evidence. Without this the server fallback can only ever read `unknown` for a host that never emitted the signal — the post-deploy condition observed on collectors enrolled before coverage was a default stream.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-connection-health`: The connection-summary projection SHALL derive a local collector's coverage axis from durable `coverage_diagnostics` records when no spine run anchors run-derived coverage, instead of leaving it `unknown`, while never promoting an empty/drained outbox to `complete`.

### Removed Capabilities

## Impact

- Affected runtime: `reference-implementation/server/ref-control.ts` (new `deriveLocalCoverageAxis` + `getConnectorLocalCoverageAxis`, optional `localCoverage` evidence threaded into `projectConnectorSummaryConnectionHealth` and consumed in `buildCoverageEvidence`; read at both summary call sites — list + detail).
- Reuses the existing `listLocalCoverageDiagnostics` read in `reference-implementation/server/records.js`; no new storage shape, no change to the heartbeat wire contract, the outbox axis taxonomy, or the device-exporter diagnostics surface.
- Affected collector emission: `packages/local-collector/src/runner.ts` (`BUNDLED_CONNECTORS` default stream sets now include `coverage_diagnostics` + safe inventory streams, mirroring the manifest); `packages/polyfill-connectors/connectors/{claude_code,codex}/index.ts` (build the source inventory and emit coverage diagnostics before the requested-content-source assert so a missing store reports `missing` instead of omitting the stream). No connector schema or manifest change — coverage was already a declared stream; only the default request set and emit ordering change.
- Affected docs: `docs/operator/local-collector-runbook.md` (coverage-by-default + older-collector one-time rerun guidance).
- Affected tests: `reference-implementation/test/ref-connectors-local-coverage-green.test.js`; `packages/local-collector/test/runner.test.js` (bundled-default coverage assertions); `packages/polyfill-connectors/connectors/{claude_code,codex}/source-preflight.test.ts` (coverage emitted before failure on a missing home).
