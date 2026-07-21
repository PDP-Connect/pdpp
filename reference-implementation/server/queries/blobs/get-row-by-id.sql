-- @terminator: one
-- Read the full content-addressed blob row (including raw bytes) for
-- `GET /v1/blobs/:blob_id`. Distinct from `get-stored-by-id.sql`, which
-- only reads metadata for post-INSERT collision checks; this one
-- includes `data` because the route returns the bytes inline.
SELECT blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data
FROM blobs
WHERE blob_id = ?
