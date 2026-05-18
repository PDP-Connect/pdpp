-- @terminator: exec
DELETE FROM lexical_search_meta
WHERE connector_instance_id = ? AND stream = ?
