# Tasks

## 1. Postgres routing in records helper

- [x] 1.1 Branch `deleteAllRecordsForConnector(connectorId)` in `reference-implementation/server/records.js` on `isPostgresStorageBackend()` and route the Postgres path through a new private `postgresDeleteAllRecordsForConnector(connectorId)` helper.
- [x] 1.2 Discover `(connector_instance_id, stream)` pairs from the Postgres `records ∪ record_changes ∪ blob_bindings` tables for the given `connector_id`.
- [x] 1.3 Per pair: issue four single-statement parameterized DELETEs against `record_changes`, `records`, `version_counter`, `blob_bindings` (one statement each so the pg-pool prepared-statement protocol accepts them), then call `markRetainedSizeStreamDirty`, `lexicalIndexDeleteByConnectorStream`, `semanticIndexDeleteByConnectorStream` for parity with the SQLite path.
- [x] 1.4 When `deletedCount > 0`, mark the dataset-summary projection stale and mark the retained-size connection dirty, matching the SQLite path.
- [x] 1.5 Add `postgresQuery` to the existing `postgres-storage.js` import in `records.js`.

## 2. Regression test

- [x] 2.1 Add `reference-implementation/test/polyfill-manifest-reconcile-invalidation-postgres.test.js`, gated on `PDPP_TEST_POSTGRES_URL`.
- [x] 2.2 Seed Postgres-backed records for a unique connector + stream via `postgresIngestRecord`.
- [x] 2.3 Invoke `deleteAllRecordsForConnector(connectorId)` and assert: `deletedCount > 0`, `streams` includes the seeded stream, and the `records` table has zero rows for that connector afterward.
- [x] 2.4 Clean up any other persisted rows under the unique connector id at teardown so the shared schema does not accumulate detritus.

## 3. Validation

- [x] 3.1 Run `openspec validate fix-polyfill-record-invalidation-postgres-routing --strict`.
- [x] 3.2 Run the existing `node --test reference-implementation/test/polyfill-manifest-reconcile-invalidation.test.js` to confirm the SQLite path is unaffected.
- [x] 3.3 Grep `reference-implementation/server` for residual unconditional connector-wide invalidation paths against `referenceQueries.recordsDelete*ByConnector`; confirm only the SQLite arm of `deleteAllRecordsForConnector` references them.
- [x] 3.4 Owner runs the new Postgres-gated regression with `PDPP_TEST_POSTGRES_URL` set against the Compose Postgres proof service and confirms `deletedCount > 0`.
