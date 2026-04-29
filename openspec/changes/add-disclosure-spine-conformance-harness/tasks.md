## 1. Harness Shape

- [x] 1.1 Inventory existing spine helper and route tests for append/list/terminal/summary behavior.
- [x] 1.2 Define a test-only disclosure-spine conformance driver under `reference-implementation/test/**`.
- [x] 1.3 Keep the driver narrow enough that it is not a production `DisclosureSpineStore` contract.

## 2. Conformance Scenarios

- [x] 2.1 Add append/list ordering scenarios for a single correlation.
- [x] 2.2 Add pagination/cursor scenarios if current helpers expose a compact list-page seam.
- [x] 2.3 Add terminal/latest event lookup scenarios.
- [x] 2.4 Add correlation summary aggregate extent scenarios, including truncated hydration if compact.
- [x] 2.5 Add rejected vs served event visibility/status scenarios if compact.

## 3. Drivers And Falsifiability

- [x] 3.1 Add a SQLite-backed driver that exercises current reference spine behavior without production code changes.
- [x] 3.2 Add a negative/falsifiability test proving the harness fails on at least one broken spine behavior.
- [x] 3.3 Decide whether any existing focused spine tests are superseded; avoid deleting route-level evidence unless replacement is obvious. (Decision: keep all existing `event-spine.test.js` route-level evidence; the new harness is helper-level conformance and complements rather than replaces route assertions.)

## 4. Validation

- [x] 4.1 Run the disclosure-spine conformance tests.
- [x] 4.2 Run nearby existing spine/timeline tests.
- [x] 4.3 Run `openspec validate add-disclosure-spine-conformance-harness --strict`.
- [x] 4.4 Run `openspec validate --all --strict`.
- [x] 4.5 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
