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

## 4. Collector-side emission (durable signal actually emitted)

The server fallback only promotes the axis off `unknown` when durable
`coverage_diagnostics` exist. Post-deploy live evidence showed some local
collectors emit zero coverage records, so they stay `coverage_unknown`. Root
cause: the published `@pdpp/local-collector` `BUNDLED_CONNECTORS` default
stream sets omitted `coverage_diagnostics`, so a default `run` never requested
it; and both connectors threw on a missing content source *before* emitting
coverage, so a partial home produced no coverage rows at all.

- [x] 4.1 Add `coverage_diagnostics` (and the safe inventory streams it
  accounts for) to the published `BUNDLED_CONNECTORS` default stream sets for
  `claude_code` and `codex` in `packages/local-collector/src/runner.ts`, so an
  unscoped `pdpp-local-collector run` emits the durable coverage signal. Pin it
  with a regression test asserting every bundled default includes
  `coverage_diagnostics` and that all defaults are manifest-declared.
- [x] 4.2 Emit `coverage_diagnostics` BEFORE the requested-content-source
  assert in both `connectors/claude_code/index.ts` and `connectors/codex/index.ts`,
  so a missing content source produces honest `missing` coverage rows instead
  of aborting with zero coverage evidence. Cover with a per-connector
  regression test (run fails on missing sources yet still emits `missing`
  coverage rows).
- [x] 4.3 Update `docs/operator/local-collector-runbook.md` so the standard
  Step 4 command documents coverage-by-default and the one-time rerun an
  older-collector host needs to leave `coverage_unknown`.

## Acceptance checks

- `node --test --import tsx reference-implementation/test/ref-connectors-local-coverage-green.test.js` — all pass.
- `node --test --import tsx reference-implementation/test/connection-health.test.js reference-implementation/test/connection-health-acceptance.test.js reference-implementation/test/ref-connectors-connection-projection.test.js` — no regressions.
- `npx tsc --noEmit` (reference-implementation) — no errors.
- `openspec validate derive-local-collector-coverage-from-diagnostics --strict` — passes.
- `node --test --import tsx packages/local-collector/test/runner.test.js` — bundled-default coverage assertions pass.
- `node --test --import tsx packages/polyfill-connectors/connectors/claude_code/source-preflight.test.ts packages/polyfill-connectors/connectors/codex/source-preflight.test.ts` — coverage-before-failure regressions pass.
- `pnpm --dir packages/polyfill-connectors run typecheck` — no errors.

## Owner-gated residual

- [ ] Headline state for a healthy drained local collector with complete coverage remains `idle` (no terminal collection verdict and freshness `unknown` without a `refresh_policy`); promoting it to `healthy` would require an ingest-as-collection-success signal, which is a separate contract decision out of scope here.
