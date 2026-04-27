-- @terminator: one
-- One-row dataset summary: live record count, JSON byte total, ingest
-- time bounds, and the distinct (connector_id, stream) totals. Used by
-- the operator console hero band via `getDatasetSummary`.
SELECT
  COUNT(*)                                         AS record_count,
  COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS record_json_bytes,
  MIN(emitted_at)                                  AS earliest_ingested_at,
  MAX(emitted_at)                                  AS latest_ingested_at,
  COUNT(DISTINCT connector_id)                     AS connector_count,
  COUNT(DISTINCT connector_id || char(10) || stream) AS stream_count
FROM records
WHERE deleted = 0
