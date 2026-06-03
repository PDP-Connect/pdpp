# Tasks: derive local collector coverage from diagnostics

## 1. Coverage axis derivation

- [x] 1.1 Add `deriveLocalCoverageAxis` in `ref-control.ts`: no rows → `unknown`; any `unaccounted` store → `gaps` (naming the stores); otherwise → `complete`.
- [x] 1.2 Add `getConnectorLocalCoverageAxis` reading `listLocalCoverageDiagnostics` scoped by `connector_instance_id` (default-account fallback when absent), returning `null` on read failure.

## 2. Rollup threading

- [x] 2.1 Add optional `localCoverage` to `projectConnectorSummaryConnectionHealth` input and pass it to `buildCoverageEvidence`.
- [x] 2.2 In `buildCoverageEvidence`, prefer the local coverage axis only when `mapCoverageAxis(...)` returns `unknown` and the local axis is non-`unknown`; run-derived coverage stays authoritative.
- [x] 2.3 Read and thread `localCoverage` at both call sites (`listConnectorSummaries`, `getConnectorDetail`).

## 3. Spec + tests

- [x] 3.1 Add the `reference-connection-health` requirement that a local collector's coverage derives from durable coverage diagnostics, never from an empty outbox.
- [x] 3.2 Add `ref-connectors-local-coverage-green.test.js`: server-rollup tests for complete / gaps / unobserved-unknown, plus run-precedence and fallback-only-when-unknown guards.

## Acceptance checks

- `node --test --import tsx reference-implementation/test/ref-connectors-local-coverage-green.test.js` — all pass.
- `node --test --import tsx reference-implementation/test/connection-health.test.js reference-implementation/test/connection-health-acceptance.test.js reference-implementation/test/ref-connectors-connection-projection.test.js` — no regressions.
- `npx tsc --noEmit` (reference-implementation) — no errors.
- `openspec validate derive-local-collector-coverage-from-diagnostics --strict` — passes.

## Owner-gated residual

- [ ] Headline state for a healthy drained local collector with complete coverage remains `idle` (no terminal collection verdict and freshness `unknown` without a `refresh_policy`); promoting it to `healthy` would require an ingest-as-collection-success signal, which is a separate contract decision out of scope here.
