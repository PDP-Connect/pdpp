## ADDED Requirements

### Requirement: Connector-wide record invalidation SHALL execute against the active storage backend

The reference implementation SHALL invalidate connector-scoped records against the active storage backend selected by `PDPP_STORAGE_BACKEND`. When the polyfill manifest reconciler fires the reference-fixture → polyfill transition (see the `reconcile-invalidates-stale-records` invariant), the connector-wide invalidation helper SHALL delete every durable record-side artifact for that `connector_id` from the backend that owns the live data — records, record-change history, version counters, blob bindings, retained-size dirtiness, dataset-summary projection staleness, and lexical/semantic index rows — and SHALL report a `deletedCount` that reflects the count of live rows it removed from that backend.

The invalidation helper SHALL NOT depend on a different backend's namespace discovery to enumerate `(connector_instance_id, stream)` pairs in the active backend.

#### Scenario: A Postgres-backed deployment reconciles the seed-fixture → polyfill transition
- **WHEN** `PDPP_STORAGE_BACKEND=postgres` and the reconciler fires the fingerprint-gated transition for a `connector_id` that has live records in the Postgres `records` table
- **THEN** the connector-wide invalidation SHALL delete those Postgres records, record_changes, version_counter, blob_bindings, and lexical/semantic index rows
- **AND** the helper SHALL return a `deletedCount` equal to the number of live (`deleted = FALSE`) Postgres `records` rows it removed
- **AND** the operator log line SHALL report the non-zero invalidation count

#### Scenario: A SQLite-backed deployment is unaffected by the routing change
- **WHEN** `PDPP_STORAGE_BACKEND` resolves to `sqlite` (the default) and the reconciler fires the fingerprint-gated transition
- **THEN** the connector-wide invalidation SHALL continue to delete SQLite `records`, `record_changes`, `version_counter`, and `blob_bindings` rows for that connector
- **AND** the returned `deletedCount` and `streams` shape SHALL match the prior SQLite-only behavior byte-for-byte

#### Scenario: A backend's namespace contains only history or blob bindings
- **WHEN** the active backend has a connector with no live `records` rows but still has `record_changes` history or surviving `blob_bindings`
- **THEN** the helper SHALL discover those `(connector_instance_id, stream)` pairs from the active backend and drop the residual history and bindings
