## Why

The reference spine now has bounded timeline reads, but its semantic guarantees are still mostly pinned by route- and implementation-specific tests. Before extracting a `DisclosureSpineStore` or claiming alternate environment/storage profiles, PDPP needs reusable conformance tests for event append/list/terminal/correlation behavior.

## What Changes

- Add a test-only disclosure-spine conformance harness with a narrow semantic driver.
- Run the harness against the current SQLite-backed reference spine implementation.
- Include a falsifiability check proving the harness detects at least one broken spine behavior.
- Keep existing focused spine and timeline tests unless a small assertion is clearly superseded.
- Do not introduce a production `DisclosureSpineStore`, Postgres adapter, operation mount, or route refactor.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: disclosure-spine behavior gains an executable conformance target before any `DisclosureSpineStore` extraction or alternate storage adapter claim.

## Impact

- Affected code should be limited to `reference-implementation/test/**` and this OpenSpec change.
- No production endpoint, public protocol shape, storage adapter, or runtime code should change.
- The harness should complement the records/search/Postgres success plan under `define-reference-operation-environments`.
