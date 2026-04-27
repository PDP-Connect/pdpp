-- @terminator: one
-- Verify a freshly-inserted (or already-existing) blob row's metadata.
-- Used immediately after INSERT OR IGNORE to detect a content-address
-- collision (different bytes hashing to the same blob_id) by comparing
-- sha256 + size_bytes to the caller's expectation.
SELECT blob_id, mime_type, size_bytes, sha256
FROM blobs
WHERE blob_id = ?
