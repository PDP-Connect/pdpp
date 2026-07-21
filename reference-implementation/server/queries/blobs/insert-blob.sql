-- @terminator: exec
-- Content-addressed blob persistence. INSERT OR IGNORE is intentional:
-- the blob_id is `blob_sha256_<hex>`, so a duplicate insert means the
-- exact bytes already exist; the caller verifies the existing row and
-- proceeds. Called inside persistContentAddressedBlob's transaction.
INSERT OR IGNORE INTO blobs(
  blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
