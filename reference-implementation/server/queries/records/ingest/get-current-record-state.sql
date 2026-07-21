-- @terminator: one
-- Read the current record_json/deleted/version state for a single
-- (connector_instance_id, stream, record_key) row. Used by ingestRecord and
-- deleteRecord to detect no-op writes and to copy the prior payload
-- into the change-log entry. `version` lets the ingest path probe whether
-- the current row's provenance anchor (the matching record_changes row at
-- this version) still exists before suppressing an unchanged write as a
-- no-op (self-heal of an anchor pruned out from under a still-current row).
SELECT record_json, deleted, version, emitted_at, semantic_time
FROM records
WHERE connector_instance_id = ? AND stream = ? AND record_key = ?
