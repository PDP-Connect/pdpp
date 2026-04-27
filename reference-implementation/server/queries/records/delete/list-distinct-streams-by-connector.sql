-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: records
-- @max_rows: 256
-- Distinct stream names with at least one row (live or soft-deleted)
-- for a connector. The result is bounded by the count of streams a
-- single connector's manifest declares (a few dozen at most), even
-- though the underlying records table can be very large; SELECT
-- DISTINCT collapses the scan to one row per stream. The wrapper's
-- @max_rows bound is a domain assertion on streams-per-connector
-- cardinality, not on the records table itself.
-- Used by `deleteAllRecordsForConnector` to enumerate streams for
-- search-index cleanup before dropping the underlying rows.
SELECT DISTINCT stream
FROM records
WHERE connector_id = ?
ORDER BY stream ASC
