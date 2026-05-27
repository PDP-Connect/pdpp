# Fix polyfill record invalidation Postgres routing

## Why

`deleteAllRecordsForConnector(connectorId)` in `reference-implementation/server/records.js` is the helper the polyfill manifest reconciler calls when the persisted manifest fingerprint matches a reference-fixture and the shipped polyfill differs (the seed → polyfill transition gate from `reconcile-invalidates-stale-records`). Today the function reads and writes only through the SQLite primitives, even though the reconciler runs on every Postgres deployment startup (`shouldAutoReconcilePolyfillManifests` defaults on for the Postgres backend).

In Postgres mode the SQLite shadow tables for `records`, `record_changes`, `version_counter`, and `blob_bindings` carry no live data, so the helper:

- iterates an empty `(connector_instance_id, stream)` namespace set,
- returns `deletedCount = 0`, and
- leaves stale records sitting in Postgres under a manifest fingerprint the system no longer declares.

The reconciler logs the operation as "no records to invalidate" and the dashboard continues advertising stale data as fresh. The class is the same as the `computeIndexState` semantic-index miss called out in `tmp/workstreams/storage-backend-routing-audit-report.md`: a writer that branches on `isPostgresStorageBackend()` and a sibling helper that does not.

While fixing this, the adjacent per-stream `postgresDeleteAllRecords(storageTarget, stream)` helper turned out to be silently broken on the same boundary: it bundled its DELETEs into a single semicolon-separated parameterized string, which `node-postgres`'s extended-protocol (prepared statements) rejects with `cannot insert multiple commands into a prepared statement`. Owner reset (`rs.records.delete_stream`) on Postgres deployments has therefore been unusable for any caller that exercises the per-stream postgres path. The connector-wide fix is a worse fix if it works around — instead of repairing — that sibling primitive, so this change closes both halves of the Postgres record-delete boundary in one pass.

## What Changes

- Branch `deleteAllRecordsForConnector` on `isPostgresStorageBackend()` and route the Postgres path through `postgresQuery` against the active Postgres pool.
- Discover `(connector_instance_id, stream)` pairs from the Postgres `records`, `record_changes`, and `blob_bindings` tables (union) so a stream whose only surviving rows are change history or blob bindings still gets invalidated.
- Repair `postgresDeleteAllRecords(storageTarget, stream)` so it runs each DELETE as a single parameterized statement under one transactional client (atomic, accepted by the prepared-statement protocol). Extract the per-pair tail into a shared `deletePostgresRecordTailForPair(client, instance, stream)` helper that both Postgres delete paths use.
- Maintain SQLite-path parity: per-stream postgres delete clears the same three core tables plus the lexical/semantic search tables for the stream; per-connector postgres delete additionally drops `blob_bindings` (mirroring the SQLite per-connector path's fourth DELETE). Retained-size, dataset-summary projection, and index-helper invocations stay where they are.
- Add a single env-gated regression `records-delete-postgres-routing.test.js` that exercises both the connector-wide and per-stream paths against a real Postgres and asserts the expected tables/index state, including sibling-stream isolation.

The SQLite path is untouched.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture` — record-delete on Postgres now resolves consistently for both stream-wide and connector-wide invalidation; both compose the same per-pair tail helper.

## Impact

- `reference-implementation/server/records.js` — adds the Postgres branch in `deleteAllRecordsForConnector` + private `postgresDeleteAllRecordsForConnector` helper that composes `postgresDeleteAllRecords` per pair and drops `blob_bindings` separately; imports `postgresQuery`.
- `reference-implementation/server/postgres-records.js` — splits `postgresDeleteAllRecords` into single-statement parameterized DELETEs under `withPostgresTransaction`; extracts `deletePostgresRecordTailForPair(client, instance, stream)` as a shared per-pair helper.
- `reference-implementation/test/records-delete-postgres-routing.test.js` — new env-gated regression covering both the connector-wide invalidation contract and the per-stream owner-reset contract, with sibling-stream isolation.
- No protocol wire-format change. No client-visible API change. The operator log line that already reports `deletedCount` now reflects reality in Postgres mode; the `rs.records.delete_stream` owner-reset path is no longer broken on Postgres.

## Residual Risks

- The new regression is env-gated on `PDPP_TEST_POSTGRES_URL`; environments without the Compose Postgres proof service skip it. This mirrors every other Postgres-runtime test in the suite. Owner should confirm CI lanes that exercise Postgres still pick it up.
