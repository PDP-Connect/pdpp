-- @terminator: one
-- Read only the size of a content-addressed blob by primary key. Distinct
-- from `get-row-by-id.sql` (which also returns the raw bytes for
-- `GET /v1/blobs/:blob_id`) and `get-stored-by-id.sql` (post-INSERT
-- collision check) — this is the lean lookup for decorating a record's
-- `blob_ref.size_bytes` without pulling the blob's bytes into memory.
SELECT size_bytes
FROM blobs
WHERE blob_id = ?
