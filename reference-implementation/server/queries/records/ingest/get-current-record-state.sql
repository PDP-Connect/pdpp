-- @terminator: one
-- Read the current record_json/deleted state for a single
-- (connector_id, stream, record_key) row. Used by ingestRecord and
-- deleteRecord to detect no-op writes and to copy the prior payload
-- into the change-log entry.
SELECT record_json, deleted
FROM records
WHERE connector_id = ? AND stream = ? AND record_key = ?
