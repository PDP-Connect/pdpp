# Tasks

## 1. Repair the per-stream Postgres helper

- [x] 1.1 In `reference-implementation/server/postgres-records.js`, replace the multi-statement parameterized DELETE in `postgresDeleteAllRecords` with individual `client.query` statements under `withPostgresTransaction` so the prepared-statement protocol accepts each call.
- [x] 1.2 Extract a shared `deletePostgresRecordTailForPair(client, connectorInstanceId, stream)` helper that runs the eight per-pair DELETEs (record_changes, records, version_counter, lexical_search_index, lexical_search_meta, semantic_search_blob, semantic_search_meta, semantic_search_backfill_progress) — matching the prior multi-statement set byte-for-byte.

## 2. Postgres routing in records helper

- [x] 2.1 Branch `deleteAllRecordsForConnector(connectorId)` in `reference-implementation/server/records.js` on `isPostgresStorageBackend()` and route the Postgres path through a new private `postgresDeleteAllRecordsForConnector(connectorId)` helper.
- [x] 2.2 Discover `(connector_instance_id, stream)` pairs from the Postgres `records ∪ record_changes ∪ blob_bindings` tables for the given `connector_id`.
- [x] 2.3 Per pair: compose `postgresDeleteAllRecords(storageTarget, stream)` (shared per-pair tail), then drop matching `blob_bindings` rows separately (mirroring the SQLite per-connector path's fourth DELETE vs. the per-stream path's three), then call `markRetainedSizeStreamDirty`, `lexicalIndexDeleteByConnectorStream`, `semanticIndexDeleteByConnectorStream`.
- [x] 2.4 When `deletedCount > 0`, mark the dataset-summary projection stale and mark the retained-size connection dirty, matching the SQLite path.
- [x] 2.5 Add `postgresQuery` to the existing `postgres-storage.js` import in `records.js`.

## 3. Regression test

- [x] 3.1 Add `reference-implementation/test/records-delete-postgres-routing.test.js`, gated on `PDPP_TEST_POSTGRES_URL`.
- [x] 3.2 Connector-wide scenario: seed Postgres-backed records across two streams under a unique connector_id; invoke `deleteAllRecordsForConnector(connectorId)`; assert `deletedCount`, returned `streams`, and zero residual rows in records / record_changes / version_counter / blob_bindings for that connector.
- [x] 3.3 Per-stream scenario: seed two streams under a unique connector_instance_id; invoke `deleteAllRecords(storageTarget, target)`; assert the target stream's tables are drained and the sibling stream's records and version_counter row are untouched.
- [x] 3.4 Clean up any persisted rows under the unique connector ids at teardown so the shared schema does not accumulate detritus.

## 4. Validation

- [x] 4.1 Run `openspec validate fix-polyfill-record-invalidation-postgres-routing --strict`.
- [x] 4.2 Run `openspec validate --all --strict`.
- [x] 4.3 Run `node --test reference-implementation/test/polyfill-manifest-reconcile-invalidation.test.js reference-implementation/test/dataset-summary-read-model.test.js reference-implementation/test/records-instance-namespace.test.js` to confirm the SQLite path is unaffected.
- [x] 4.4 Run `PDPP_TEST_POSTGRES_URL=... node --test reference-implementation/test/records-delete-postgres-routing.test.js` to confirm both Postgres scenarios pass.
- [x] 4.5 Grep `reference-implementation/server` for residual unconditional connector-wide invalidation paths against `referenceQueries.recordsDelete*ByConnector`; confirm only the SQLite arm of `deleteAllRecordsForConnector` references them.
