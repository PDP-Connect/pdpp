-- @terminator: one
-- Total row count (live + soft-deleted) across every stream for one
-- connector. Used by `deleteAllRecordsForConnector` to report how many
-- rows it removed before dropping them.
SELECT COUNT(*) AS count
FROM records
WHERE connector_id = ?
