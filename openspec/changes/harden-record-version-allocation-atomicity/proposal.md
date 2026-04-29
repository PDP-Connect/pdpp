## Why

The record mutation harness proves no-op, delete, rollback, and contiguous change-log behavior, but the production SQLite path still allocates the next stream version with a read-then-write sequence. SQLite serializes writers enough for the current runtime, but that shape is bug-prone for any future PostgreSQL-compatible adapter contract.

## What Changes

- Replace record-version allocation with an atomic production operation inside the durable record mutation transaction.
- Add regression coverage that proves changed writes for the same `(connector_id, stream)` cannot duplicate versions and that consumers observe a contiguous change sequence.
- Keep lexical, semantic, and disclosure-spine maintenance outside the durable record transaction.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Production code: `reference-implementation/server/records.js` and registered SQL artifacts.
- Tests: record-mutation conformance and focused record ingest/change-log tests.
- Out of scope: extracting a production `RecordStore`, adding runtime PostgreSQL, or changing public record/query response shapes.
