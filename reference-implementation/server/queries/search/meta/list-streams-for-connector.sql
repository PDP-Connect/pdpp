-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: lexical_search_meta
-- @max_rows: 1024
SELECT stream
FROM lexical_search_meta
WHERE connector_instance_id = ?
