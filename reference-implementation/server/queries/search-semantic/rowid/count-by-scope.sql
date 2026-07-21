-- @terminator: one
SELECT COUNT(*) AS n FROM semantic_search_rowid
WHERE connector_id = ? AND scope_key = ?
