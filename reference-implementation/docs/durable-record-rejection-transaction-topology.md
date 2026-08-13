# Durable Rejection Transaction Topology

This note records the #123 integration boundary after transplanting durable
record rejections onto the accepted #112/#113 durability stack.

## Accepted Seams

- Accepted record writes stay per-record transactions. `ingestRecord` enters
  `withConnectorInstanceWrite`, and PostgreSQL uses the same
  `lockConnectorInstanceId` transaction lock. The batch path intentionally does
  not hold one transaction across all input lines.
- Terminal collector state belongs to `terminal-run-commit-store.ts`. It writes
  state delta, terminal spine event, and run-history projection inside one
  caller-owned SQLite handle or PostgreSQL client.
- Rejection insert/replay is a destination result for one failed input line. It
  must be atomic with its own quota row and fixed-field audit fact, and it must
  re-check connection/run writability inside the same backend transaction.

## #123 Boundary

- Hosted `POST /v1/ingest/:stream` enters `withConnectorInstanceWrite` before
  it opens the rejection durability transaction. This composes with the accepted
  connector-instance coordinator for the failed line's admitted instance.
- `insertOrReplaySqliteRecordRejectionInTransaction(db, input)` performs the
  writable/run check, replay lookup/update, quota admission, receipt insert, and
  audit insert on the caller's explicit SQLite handle.
- `insertOrReplayPostgresRecordRejectionWithClient(client, input)` performs the
  same work on the caller's explicit `PoolClient`.
- Hosted rejection wrappers open one backend transaction for the failed line's
  rejection, quota, and audit effects, then delegate to those seams. SQLite uses
  the coordinator-held process gate plus `writeTransaction`; PostgreSQL uses the
  same process gate plus `withPostgresTransaction({ lockConnectorInstanceId })`.
- Standalone store wrappers remain compatibility adapters for non-route callers
  and still delegate to the backend-local seams.

## Non-Claims

- This does not make one hosted ingest request into a single batch transaction.
  That would conflict with the accepted per-record durable-prefix behavior.
- This does not add a generic unit-of-work abstraction.
- This does not close deferred production gates for first/latest provenance,
  retained-size projection, stale pending resolution, larger buffered payload
  support, or #108 backup inventory.
