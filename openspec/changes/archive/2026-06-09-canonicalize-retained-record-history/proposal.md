## Why

Some retained record histories contain duplicate versions emitted by older or weaker connector code when only acquisition metadata changed. Operators need a safe way to compact those histories so an old-bad-then-compacted stream converges with the canonical owner-visible history a corrected connector would have produced from day one.

## What Changes

- Add an opt-in canonical compaction mode for retained record history.
- Require compactable streams to bind connector no-op suppression and historical compaction to the same canonical fingerprint rule.
- Distinguish semantic record payload from non-versioning acquisition/provenance metadata.
- Preserve default audit-mode compaction for streams without an explicit immutable/canonical policy.
- Validate the first implementation against a copied database before applying to live retained history.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: specify canonical retained-history compaction eligibility, convergence, and safety boundaries.

## Impact

- `reference-implementation/scripts/compact-record-history.mjs`
- `reference-implementation/scripts/compact-record-history-dry-run-all.mjs`
- `reference-implementation/test/compact-record-history-*.test.*`
- `packages/polyfill-connectors/src/fingerprint-cursor.ts`
- Connector stream policy definitions for initial eligible streams, beginning with `chase/transactions`
- Operator evidence artifacts under `tmp/workstreams/` for copied-database validation
