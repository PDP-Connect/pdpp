-- @terminator: one
-- Count of every row (live + soft-deleted) for one
-- (connector_instance_id, stream). Used by `deleteAllRecords` to report how many
-- rows it removed.
SELECT COUNT(*) AS count
FROM records
WHERE connector_instance_id = ? AND stream = ?
