-- @terminator: exec
DELETE FROM lexical_search_meta
WHERE connector_id = ? AND stream = ?
