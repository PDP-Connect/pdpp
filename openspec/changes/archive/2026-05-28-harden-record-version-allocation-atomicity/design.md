## Context

`harden-record-ingest-atomicity` made durable record mutation transactional. The remaining portability risk is version allocation: the current sequence reads `version_counter`, computes `nextVersion`, writes records/change rows, then upserts the counter.

That is acceptable for the current SQLite writer model, but it is not a contract we should carry into a future storage adapter. The reference should demonstrate the stronger semantic now: version allocation is atomic with respect to the durable mutation.

## Decision

The production record mutation path SHALL allocate the next stream version with a single atomic store operation inside the durable mutation transaction.

Acceptable SQLite shapes include:

- `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING max_version`
- an equivalent CTE that updates or creates the counter and returns the allocated version

The implementation SHALL preserve current public behavior:

- identical re-ingest remains a no-op and does not allocate a version;
- repeated delete remains a no-op and does not allocate a version;
- changed writes append one `record_changes` row per durable mutation;
- `changes_since` observes a contiguous stream version sequence.

## Stop Conditions

Stop for owner review if the implementation:

- introduces a production `RecordStore`, generic `StorageBackend`, Kysely, or runtime PostgreSQL;
- moves lexical, semantic, or disclosure-spine maintenance into the durable record transaction;
- changes public record, delete, ingest, or `changes_since` response shapes;
- requires destructive migration of existing record or version-counter data.

## Acceptance Checks

- A regression test proves two changed writes for the same `(connector_id, stream)` allocate distinct monotonically increasing versions.
- No-op re-ingest and repeated delete still do not advance `version_counter`.
- `changes_since` or direct change-log assertions show a contiguous version sequence.
- Existing record mutation/read, lexical, semantic, and operation-boundary tests remain green.
