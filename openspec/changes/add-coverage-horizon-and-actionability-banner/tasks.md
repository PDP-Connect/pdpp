## 1. Coverage horizon evidence

- [x] Add `runtime/coverage-horizon.ts` (type, closed basis/reason vocabulary, pure disclosure copy) and `server/stores/connector-coverage-horizon-store.ts` (append-only, supersession-on-confirm, SQLite and Postgres).
- [x] Add the `connector_coverage_horizons` table to both backends' schema bootstrap, marked `backup_required`.
- [x] Thread `coverageHorizons` through `ComputeConnectionHealthInput` -> `ConnectionHealthSnapshot.coverage_horizons` -> `RenderedVerdict.detail.coverage_horizons` as a pure pass-through annotation.
- [x] Wire the field through `ref-control.ts`'s `projectConnectorSummaryConnectionHealth` and `ConnectorSummary.coverage_horizons` (defaults to empty; no list-page caller reads the store yet — see design.md).

## 2. Fleet banner actionability gate

- [x] Export `staleFreshnessIsSoleDegradation` from `rendered-verdict.ts`.
- [x] Exclude a headline `degraded` state caused entirely by ordinary cadence-relative staleness from `fleet-health.ts`'s `materiallyBlocked` gate, reusing the exported predicate.

## 3. Verification

- [x] Add `test/coverage-horizon.test.ts`: pass-through integration plus the two required negative tests (provider-retention boundary cannot become a retryable failure; unproven boundary cannot be accepted as provider reality).
- [x] Add `fleet-health.test.ts` negative tests: an automatic connector past cadence-relative staleness cannot fire the banner (reproduces the defect: fails before the fix, passes after); a proven current success cannot be overridden by an older, non-current false condition.
- [x] Confirm `proof-age-cry-wolf-freshness.test.ts` and the full `fleet-health.test.ts`/`rendered-verdict*.test.ts`/`connection-health.test.ts` suites stay green.
- [x] `pnpm typecheck` and `pnpm reference-implementation:test` pass.
- [x] `test/ri-zero-connector-knowledge-conformance.test.ts` passes (no connector/provider-ID branching in any touched module).
- [x] `openspec validate add-coverage-horizon-and-actionability-banner --strict` and `openspec validate --all --strict` pass.
