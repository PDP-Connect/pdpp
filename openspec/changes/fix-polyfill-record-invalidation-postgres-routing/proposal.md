# Fix polyfill record invalidation Postgres routing

## Why

`deleteAllRecordsForConnector(connectorId)` in `reference-implementation/server/records.js` is the helper the polyfill manifest reconciler calls when the persisted manifest fingerprint matches a reference-fixture and the shipped polyfill differs (the seed → polyfill transition gate from `reconcile-invalidates-stale-records`). Today the function reads and writes only through the SQLite primitives, even though the reconciler is run on every Postgres deployment startup (`shouldAutoReconcilePolyfillManifests` defaults on for the Postgres backend).

In Postgres mode the SQLite shadow tables for `records`, `record_changes`, `version_counter`, and `blob_bindings` carry no live data, so the helper:

- iterates an empty `(connector_instance_id, stream)` namespace set,
- returns `deletedCount = 0`, and
- leaves stale records sitting in Postgres under a manifest fingerprint the system no longer declares.

The reconciler logs the operation as "no records to invalidate" and the dashboard continues advertising stale data as fresh. The class is the same as the `computeIndexState` semantic-index miss called out in `tmp/workstreams/storage-backend-routing-audit-report.md`: a writer that branches on `isPostgresStorageBackend()` and a sibling helper that does not.

## What Changes

- Branch `deleteAllRecordsForConnector` on `isPostgresStorageBackend()` and route the Postgres path through `postgresQuery` against the active Postgres pool.
- Discover `(connector_instance_id, stream)` pairs from the Postgres `records`, `record_changes`, and `blob_bindings` tables (union) so a stream whose only surviving rows are change history or blob bindings still gets invalidated.
- Maintain parity with the SQLite path: drop records, record_changes, version_counter, blob_bindings (each as a single parameterized statement so the pg-pool prepared protocol accepts it); tear down lexical and semantic index rows via the existing helpers, which already branch on the active backend; mark retained-size stream/connection dirty; mark the dataset-summary projection stale when the count is nonzero.
- Add an env-gated regression test that seeds Postgres-backed records and asserts the connector-wide invalidation returns a non-zero `deletedCount` and removes the rows.

The SQLite path is untouched.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture` — `deleteAllRecordsForConnector` now consults the active storage backend and SHALL invalidate Postgres-resident records when the reconciler fires on a Postgres deployment.

## Impact

- `reference-implementation/server/records.js` — adds the Postgres branch + private helper; imports `postgresQuery`.
- `reference-implementation/test/polyfill-manifest-reconcile-invalidation-postgres.test.js` — new env-gated regression that proves a Postgres-backed connector with seeded records reports a non-zero `deletedCount` and zero residual rows after the connector-wide invalidation path runs.
- No protocol wire-format change. No client-visible API change. The operator log line that already reports `deletedCount` now reflects reality in Postgres mode.

## Residual Risks

- The new regression is env-gated on `PDPP_TEST_POSTGRES_URL`; environments without the Compose Postgres proof service skip it. This mirrors every other Postgres-runtime test in the suite. Owner should confirm CI lanes that exercise Postgres still pick it up.
