-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: semantic_search_meta
-- @max_rows: 1024
SELECT stream FROM semantic_search_meta WHERE connector_id = ?
