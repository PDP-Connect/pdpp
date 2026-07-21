-- @terminator: exec
DELETE FROM semantic_search_blob
WHERE connector_id = ? AND scope_key = ?
