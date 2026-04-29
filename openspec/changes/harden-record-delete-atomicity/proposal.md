## Why

The owner-authenticated `deleteRecord` path still mutates `records`, `record_changes`, and `version_counter` through separate autocommitted statements. The adjacent ingest path now uses an immediate write transaction, but direct record deletes can still leave live state, change history, and cursor state inconsistent if a failure lands between durable steps.

## What Changes

- Add focused tests proving direct record delete is atomic for durable record mutation.
- Wrap `deleteRecord`'s current-state read, no-op decision, version allocation, live-record delete, `record_changes` append, `version_counter` advance, and existing prune in the existing `writeTransaction` helper.
- Keep lexical and semantic index deletes outside the durable transaction and only after commit.
- Preserve current public API behavior: absent/already-deleted records return `0`; successful deletes return `1`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: direct record delete durability becomes symmetric with record ingest durability.

## Impact

- Affected code: `reference-implementation/server/records.js`, focused reference tests.
- Affected behavior: direct owner deletes become atomic and writer-serialized for the same durable record-history tables as ingest.
- No public API shape change is intended.
- No Postgres support, generic storage abstraction, operation-capsule refactor, or search-index recovery change is introduced by this change.
