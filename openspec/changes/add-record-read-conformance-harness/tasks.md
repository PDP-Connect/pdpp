## 1. Harness Shape

- [x] 1.1 Inventory existing record read/list tests for pagination, cursor, `changes_since`, projection, filters, and `expand[]`.
- [x] 1.2 Define a test-only record-read conformance driver under `reference-implementation/test/**`.
- [x] 1.3 Keep the driver narrow enough that it is not a production `RecordStore` contract.

## 2. Conformance Scenarios

- [x] 2.1 Add stable pagination and cursor round-trip scenarios.
- [x] 2.2 Add missing/null cursor-field ordering scenarios if current fixtures can cover them compactly.
- [x] 2.3 Add `changes_since=beginning` bootstrap and next-cursor scenarios.
- [x] 2.4 Add field projection scenarios proving ungranted or unrequested fields do not leak.
- [x] 2.5 Add declared exact/range filter scenarios.
- [ ] 2.6 ~~Add safe `expand[]` scenario if it can be done without a mini-runtime~~ — deferred. `expand[]` requires a parent/child stream pair with a declared relationship and a meaningful relationship index; the existing route-level `query-contract.test.js` covers expand semantics across saved_tracks/recently_played, messages/attachments, messages/thread, etc. Rebuilding that surface inside the semantic harness would require a mini-runtime (relationship resolution, foreign-key grouping, expand_limit handling) that the design doc explicitly rules out. Tracked as a follow-up: a future change should extract the expand-relationship semantics into the harness once the parent/child driver shape is settled, or fold them in alongside the eventual `RecordStore` extraction.

## 3. Drivers And Falsifiability

- [x] 3.1 Add a SQLite-backed driver that exercises current reference read behavior without production code changes.
- [x] 3.2 Add a negative/falsifiability test proving the harness fails on at least one broken read behavior.
- [x] 3.3 Decide whether any existing focused tests are superseded; avoid deleting route-level evidence unless replacement is obvious. — Decision: retain `records-cursor-fallback.test.js`, `records-nullable-cursor.test.js`, `records-nullable-filters.test.js` as direct route-level evidence. The conformance harness exercises the same semantic invariants through the public `queryRecords` helper but does not duplicate the HTTP route, query-parameter parsing, validator, or 400/500 boundary cases those suites pin. Same pattern as the mutation-side decision in `add-record-mutation-conformance-harness`.

## 4. Validation

- [x] 4.1 Run the record-read conformance tests.
- [x] 4.2 Run nearby existing record read/list tests.
- [x] 4.3 Run `openspec validate add-record-read-conformance-harness --strict`.
- [x] 4.4 Run `openspec validate --all --strict`.
- [x] 4.5 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
