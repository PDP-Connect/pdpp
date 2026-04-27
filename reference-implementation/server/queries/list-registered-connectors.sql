-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: connectors
-- @max_rows: 256
SELECT connector_id, manifest
FROM connectors
ORDER BY connector_id ASC
