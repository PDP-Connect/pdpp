## Why

Record ingest currently allocates per-stream versions with separate read/write statements and no explicit durable mutation transaction. That creates a latent correctness risk for `changes_since`, replay, and future adapter work: a crash or contended writer can leave `records`, `record_changes`, and `version_counter` inconsistent.

## What Changes

- Add tests that prove record ingest is atomic for durable record mutation.
- Make current-state read, no-op detection, version allocation, live-record mutation, `record_changes` append, and `version_counter` advance one writer-serialized unit.
- Preserve current behavior for no-op re-ingest and repeated delete.
- Keep lexical index writes, semantic index writes, and disclosure-spine events outside the durable record transaction.
- Document any discovered baseline bug with evidence before fixing it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: record ingest durability becomes an explicit reference obligation instead of an accidental SQLite behavior.

## Impact

- Affected code: `reference-implementation/server/records.js`, record-ingest SQL under `reference-implementation/server/queries/records/ingest/`, and focused reference tests.
- Affected behavior: durable record mutation becomes atomic and writer-serialized per `(connector_id, stream)` where required.
- No public API shape change is intended.
- No Postgres support, generic storage abstraction, or operation-capsule refactor is introduced by this change.
