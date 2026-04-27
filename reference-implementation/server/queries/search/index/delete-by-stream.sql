-- @terminator: exec
DELETE FROM lexical_search_index
WHERE connector_id = ? AND stream = ?
