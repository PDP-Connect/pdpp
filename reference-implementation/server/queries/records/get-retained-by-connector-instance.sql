-- @terminator: one
-- Bytes retained for one concrete connector connection across live records,
-- retained record history, and blob payloads.
SELECT
  (
    SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0)
    FROM records
    WHERE connector_id = ?
      AND connector_instance_id = ?
      AND deleted = 0
  ) AS record_json_bytes,
  (
    SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0)
    FROM record_changes
    WHERE connector_id = ?
      AND connector_instance_id = ?
      AND record_json IS NOT NULL
  ) AS record_changes_json_bytes,
  (
    SELECT COALESCE(SUM(size_bytes), 0)
    FROM blobs
    WHERE connector_id = ?
      AND connector_instance_id = ?
  ) AS blob_bytes
