-- @terminator: exec
DELETE FROM semantic_search_meta
WHERE connector_id = ? AND stream = ?
