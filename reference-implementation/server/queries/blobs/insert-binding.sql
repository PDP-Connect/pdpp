-- @terminator: exec
-- Record that a (connector_instance_id, stream, record_key) tuple references this
-- blob. INSERT OR IGNORE because the same record may re-emit on a
-- subsequent ingest run; the composite primary key collapses duplicates.
--
-- json_path = '@record' marks this as a record-level binding (the blob
-- belongs to the record as a whole, not to a specific JSON Pointer in
-- record_json). The migrate-storage tool, when extracting binary leaves
-- from legacy record_json, uses an RFC 6901 JSON Pointer instead.
-- See docs/reference/binary-content-invariant-design-brief.md §4.6.
INSERT OR IGNORE INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
VALUES(?, ?, ?, ?, ?, '@record')
