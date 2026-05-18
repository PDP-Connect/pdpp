-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: connector_state
-- @max_rows: 256
-- All connector-instance-scoped sync-state rows for one connector instance. Bound by
-- streams-per-connector cardinality (≤ ~50 in practice), which the
-- registry caps at 256 — exceeding this means the manifest model
-- itself has grown and the bound needs revisiting.
SELECT stream, state_json, updated_at
FROM connector_state
WHERE connector_id = ? AND connector_instance_id = ?
