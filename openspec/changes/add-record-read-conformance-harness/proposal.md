## Why

Record mutation now has a reusable conformance harness, but record reads still rely on route-specific tests and SQLite-shaped implementation details. Before extracting `RecordStore` read paths or proving a second storage adapter, PDPP needs reusable tests for cursor, filter, projection, and `changes_since` semantics.

## What Changes

- Add a test-only record-read conformance harness with a narrow driver shape for read/list behavior.
- Run the harness against the current SQLite-backed reference implementation.
- Include a falsifiability check proving the harness catches at least one broken read behavior.
- Keep existing focused route/search tests unless the harness clearly supersedes a small duplicated assertion.
- Do not introduce a production `RecordStore`, Postgres adapter, operation mount, or route refactor.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: durable record read behavior gains an executable conformance target before any `RecordStore` read extraction or alternate storage adapter claim.

## Impact

- Affected code should be limited to `reference-implementation/test/**` and this OpenSpec change.
- No production endpoint, public protocol shape, storage adapter, or runtime code should change.
- The harness should complement `add-record-mutation-conformance-harness` and the records/search/Postgres success plan under `define-reference-operation-environments`.
