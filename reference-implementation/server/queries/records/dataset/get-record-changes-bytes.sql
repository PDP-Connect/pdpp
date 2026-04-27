-- @terminator: one
-- Total bytes retained in `record_changes` for non-tombstone entries.
-- Counts historical record JSON kept by design for change-tracking.
SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS record_changes_json_bytes
FROM record_changes
WHERE record_json IS NOT NULL
