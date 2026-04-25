## Why

`expand[]` is implemented and grant-safe, but only a small set of first-party parent-child relations are enabled. Assistants still have to do N+1 reads for common records such as Slack messages with attachments/reactions or other safe child collections.

## What Changes

- Audit first-party manifests for safe parent-to-child relations where the child stream has the parent's primary key as a top-level foreign key.
- Enable `query.expand` only for relations that match the existing one-hop, parent-to-child expansion engine.
- Add regression tests using first-party manifests and synthetic records.
- Document which tempting reverse/belongs-to relations remain out of scope.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: require first-party expansion declarations to be conservative, validated, and grant-safe.

## Impact

- `packages/polyfill-connectors/manifests/*.json`
- `reference-implementation/server/auth.js`
- `reference-implementation/test/query-contract.test.js`
- `reference-implementation/test/polyfill-range-filters.test.js` or a new first-party expand test
- docs/cookbook examples if new expands become part of the public reference walkthrough
