-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: records
-- @max_rows: 256
-- Per-stream record-count + last-emitted aggregate for a single
-- connector, used to project freshness for `/_ref/connectors[/:id]`.
-- The result is bounded by the count of streams declared by a single
-- connector's manifest (dozens at most), even though the underlying
-- table can be large; GROUP BY collapses the scan to one row per
-- stream. The wrapper's max_rows bound is a domain assertion on the
-- streams-per-connector cardinality, not on the records table itself.
SELECT
  stream,
  COUNT(*) AS record_count,
  MAX(emitted_at) AS last_updated
FROM records
WHERE connector_id = ?
  AND deleted = 0
GROUP BY stream
ORDER BY stream ASC
