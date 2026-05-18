-- @terminator: one
SELECT COUNT(*) AS n
FROM records
WHERE connector_id = ? AND stream = ? AND deleted = 0
