-- @terminator: one
SELECT COUNT(*) AS n
FROM lexical_search_index
WHERE connector_id = ? AND stream = ?
