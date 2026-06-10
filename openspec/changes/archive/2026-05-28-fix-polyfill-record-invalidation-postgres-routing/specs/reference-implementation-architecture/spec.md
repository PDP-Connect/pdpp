## ADDED Requirements

### Requirement: Record-delete on the active storage backend SHALL be consistent across stream-wide and connector-wide invalidation

The reference implementation SHALL execute record deletion against the active storage backend selected by `PDPP_STORAGE_BACKEND`. Both the per-stream owner-reset path (`deleteAllRecords(storageTarget, stream)`, called by `rs.records.delete_stream`) and the connector-wide invalidation path (`deleteAllRecordsForConnector(connectorId)`, called by the polyfill manifest reconciler on the seed-fixture → polyfill transition) SHALL run against the same backend, SHALL share the same per-pair durable-tail construction, and SHALL succeed for the same payloads they support on SQLite. Neither path SHALL fail at runtime under the active Postgres storage backend with an error that indicates an internal SQL construction defect (for example, the pg extended-protocol prepared-statement multi-statement restriction).

The per-pair durable tail SHALL clear `record_changes`, `records`, `version_counter`, and the lexical and semantic search tables scoped to that `(connector_instance_id, stream)` pair. The connector-wide path SHALL additionally drop `blob_bindings` for the pair, mirroring the SQLite per-connector path's superset of the SQLite per-stream path. The connector-wide path SHALL NOT depend on a different backend's namespace discovery to enumerate `(connector_instance_id, stream)` pairs in the active backend.

#### Scenario: A Postgres-backed deployment reconciles the seed-fixture → polyfill transition
- **WHEN** `PDPP_STORAGE_BACKEND=postgres` and the reconciler fires the fingerprint-gated transition for a `connector_id` that has live records in the Postgres `records` table
- **THEN** the connector-wide invalidation SHALL delete those Postgres records, record_changes, version_counter, blob_bindings, and lexical/semantic index rows
- **AND** the helper SHALL return a `deletedCount` equal to the number of live (`deleted = FALSE`) Postgres `records` rows it removed
- **AND** the operator log line SHALL report the non-zero invalidation count

#### Scenario: A Postgres-backed owner reset clears one stream and leaves siblings intact
- **WHEN** `PDPP_STORAGE_BACKEND=postgres` and `deleteAllRecords(storageTarget, target_stream)` is invoked for a `(connector_id, connector_instance_id)` that has live records on `target_stream` and on at least one sibling stream
- **THEN** the helper SHALL succeed (no prepared-statement multi-statement runtime error) and SHALL return the count of live records it removed from `target_stream`
- **AND** Postgres `records`, `record_changes`, `version_counter`, and `lexical_search_*` / `semantic_search_*` rows scoped to `target_stream` SHALL be removed
- **AND** the sibling stream's records and `version_counter` row SHALL be untouched

#### Scenario: A SQLite-backed deployment is unaffected by the routing change
- **WHEN** `PDPP_STORAGE_BACKEND` resolves to `sqlite` (the default) and either the per-stream or connector-wide delete path is invoked
- **THEN** the helper SHALL continue to delete from SQLite using the existing `referenceQueries.recordsDelete*` primitives
- **AND** the returned `deletedCount` and `streams` shape SHALL match the prior SQLite-only behavior byte-for-byte

#### Scenario: A backend's namespace contains only history or blob bindings
- **WHEN** the active backend has a connector with no live `records` rows but still has `record_changes` history or surviving `blob_bindings`
- **THEN** the connector-wide helper SHALL discover those `(connector_instance_id, stream)` pairs from the active backend and drop the residual history and bindings
