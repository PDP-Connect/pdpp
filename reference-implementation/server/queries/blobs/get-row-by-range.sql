-- @terminator: one
-- Read one selected byte range from a content-addressed blob row. SQLite
-- substr() counts bytes for BLOB values, so the route converts its zero-based
-- inclusive range to the SQL one-based start + byte count parameters.
SELECT blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256,
       substr(data, ?, ?) AS data
FROM blobs
WHERE blob_id = ?
