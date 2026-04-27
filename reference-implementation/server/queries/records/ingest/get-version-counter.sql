-- @terminator: one
-- Read the current max_version for a (connector_id, stream) pair so
-- the next ingest/delete can advance to (max_version + 1). Returns null
-- the first time records are ingested into the stream.
SELECT max_version
FROM version_counter
WHERE connector_id = ? AND stream = ?
