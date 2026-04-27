-- @terminator: exec
-- Record that a (connector_id, stream, record_key) tuple references this
-- blob. INSERT OR IGNORE because the same record may re-emit on a
-- subsequent ingest run; the (blob_id, connector_id, stream, record_key)
-- composite primary key collapses duplicate bindings.
INSERT OR IGNORE INTO blob_bindings(blob_id, connector_id, stream, record_key)
VALUES(?, ?, ?, ?)
