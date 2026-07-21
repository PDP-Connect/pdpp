-- @terminator: one
SELECT COUNT(*) AS n
FROM lexical_search_index
WHERE connector_instance_id = ? AND stream = ?
