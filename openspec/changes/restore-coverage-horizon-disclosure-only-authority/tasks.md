## 1. Remove the completeness authority

- [x] Remove `ConnectionCoverageEvidence.horizonAccountedRetryableGap` and the `sourceCoverageCondition` branch that honored it (`runtime/connection-health.ts`).
- [x] Remove the now-unreachable `COVERAGE_COMPLETE_HORIZON_ACCOUNTED` condition reason.
- [x] Remove `computeHorizonAccountedRetryableGap` and drop the `coverageHorizons` argument from `buildCoverageEvidence`/`applyCoverageOverride` (`server/ref-control.ts`).
- [x] Remove `isProvenPreHorizonGap`, `isStreamFullyHorizonAccounted`, and their private helpers (`hasProviderHistoryBoundaryClaim`, `QUALIFYING_HORIZON_BASES`, `currentHorizonForStream`) from `server/connector-gap-classification.ts`, replacing them with the disclosure-only rationale.

## 2. Keep disclosure intact

- [x] Leave the horizon store, the `POST /_ref/connections/:id/coverage-horizon` confirm route, supersession, `ConnectionHealthSnapshot.coverage_horizons`, and `RenderedVerdict.detail.coverage_horizons` unchanged.
- [x] Leave `PERSISTED_BOUNDARY_CLAIMS` validation and persistence in `runtime/connector-gap-bounding.ts` unchanged, so a recognized claim still reaches the durable gap and an unrecognized one is still dropped.
- [x] Correct the doc comments that asserted the removed denominator rule (`runtime/coverage-horizon.ts`, the confirm route, `ref-control.ts`'s `boundary_claim` doc).

## 3. Verification

- [x] Add `test/coverage-horizon-disclosure-only-authority.test.ts`: the `earliestAvailable: null` false green, a gap inside the servable interval, multiple claiming gaps, GroupMe/USAA claim + any-horizon, byte-identical classification with and without a horizon, and disclosure preserved through the snapshot and rendered verdict. Fails 9/12 before the change, passes 12/12 after.
- [x] Rewrite the tests that pinned the removed behavior into their inverses rather than deleting their coverage: `coverage-horizon.test.ts`, `coverage-horizon-weak-basis.test.ts`, `groupme-like-pre-horizon-coverage-wiring.test.ts`.
- [x] Remove the `connector-gap-classification.test.ts` block that unit-tested the deleted predicates, recording where the contract is now proven.
- [x] Replace the weak-basis suite's `notEqual` against the deleted reason string with a positive assertion, so it cannot pass vacuously.
- [x] Health/coverage/verdict regression sweep green (1194/1196; one pre-existing environment failure unrelated to this change, one skip).
- [x] `scripts/stream-health-audit/authority.test.ts` and the GroupMe `skip-result-boundary-claim-contract.test.ts` stay green.
