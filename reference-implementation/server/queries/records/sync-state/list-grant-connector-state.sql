-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_connector_state
-- @max_rows: 256
-- All grant-scoped sync-state rows for one (connector_instance_id, grant_id).
-- Bound by streams-per-connector cardinality (a few dozen at most),
-- which the registry caps at 256 — exceeding this means the manifest
-- model itself has grown and the bound needs revisiting.
SELECT stream, state_json, updated_at
FROM grant_connector_state
WHERE connector_id = ? AND connector_instance_id = ? AND grant_id = ?
