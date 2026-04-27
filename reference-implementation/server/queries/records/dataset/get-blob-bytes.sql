-- @terminator: one
-- Total bytes stored in the blobs table. Blobs are not soft-deleted.
SELECT COALESCE(SUM(size_bytes), 0) AS blob_bytes
FROM blobs
