-- @terminator: one
SELECT rowid FROM semantic_search_rowid
WHERE connector_instance_id = ? AND scope_key = ? AND record_key = ?
