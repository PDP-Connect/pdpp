## 1. Harness Shape

- [ ] 1.1 Inventory existing record read/list tests for pagination, cursor, `changes_since`, projection, filters, and `expand[]`.
- [ ] 1.2 Define a test-only record-read conformance driver under `reference-implementation/test/**`.
- [ ] 1.3 Keep the driver narrow enough that it is not a production `RecordStore` contract.

## 2. Conformance Scenarios

- [ ] 2.1 Add stable pagination and cursor round-trip scenarios.
- [ ] 2.2 Add missing/null cursor-field ordering scenarios if current fixtures can cover them compactly.
- [ ] 2.3 Add `changes_since=beginning` bootstrap and next-cursor scenarios.
- [ ] 2.4 Add field projection scenarios proving ungranted or unrequested fields do not leak.
- [ ] 2.5 Add declared exact/range filter scenarios.
- [ ] 2.6 Add safe `expand[]` scenario if it can be done without a mini-runtime; otherwise document the follow-up explicitly.

## 3. Drivers And Falsifiability

- [ ] 3.1 Add a SQLite-backed driver that exercises current reference read behavior without production code changes.
- [ ] 3.2 Add a negative/falsifiability test proving the harness fails on at least one broken read behavior.
- [ ] 3.3 Decide whether any existing focused tests are superseded; avoid deleting route-level evidence unless replacement is obvious.

## 4. Validation

- [ ] 4.1 Run the record-read conformance tests.
- [ ] 4.2 Run nearby existing record read/list tests.
- [ ] 4.3 Run `openspec validate add-record-read-conformance-harness --strict`.
- [ ] 4.4 Run `openspec validate --all --strict`.
- [ ] 4.5 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
