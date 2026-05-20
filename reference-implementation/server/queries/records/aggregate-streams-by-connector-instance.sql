-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: records
-- @max_rows: 256
-- Per-stream live-record aggregate for one concrete connector connection.
SELECT
  stream,
  COUNT(*) AS record_count,
  MAX(emitted_at) AS last_updated
FROM records
WHERE connector_id = ?
  AND connector_instance_id = ?
  AND deleted = 0
GROUP BY stream
ORDER BY stream ASC
