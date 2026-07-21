-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: records
-- @max_rows: 256
-- Distinct streams that have at least one row (live or soft-deleted) for one
-- connector_instance_id. Used by the connection-delete cascade to drive
-- per-stream search-index teardown (lexical + semantic) through the proven
-- stream-scoped helpers, which correctly tear down the SQLite vec0 sidecar that
-- a flat by-instance DELETE cannot. Spec: add-owner-connection-delete-contract.
SELECT DISTINCT stream
FROM records
WHERE connector_instance_id = ?
ORDER BY stream ASC
