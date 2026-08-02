-- @terminator: many
-- @cursor_field: connector_id
-- Enumerate every (connector_id, connector_instance_id, stream, record_key) tuple that
-- references the given blob_id, including the originating
-- (connector_id, connector_instance_id, stream, record_key) recorded directly on the
-- `blobs` row at upload time. Used by `GET /v1/blobs/:blob_id`
-- visibility evaluation: the route iterates bindings, attempts a
-- record read under the actor's grant for each, and only returns
-- the blob bytes when at least one visible record exposes the
-- requested blob via `data.blob_ref.blob_id`.
--
-- The wrapper binds one extra row to the `LIMIT ?` placeholder so the
-- BlobStore can detect overflow. An overflow is an incomplete visibility
-- proof and must fail closed; it is not an authorization result.
SELECT 0 AS id, connector_id, connector_instance_id, stream, record_key
FROM blob_bindings
WHERE blob_id = ?
UNION
SELECT 0 AS id, connector_id, connector_instance_id, stream, record_key
FROM blobs
WHERE blob_id = ?
ORDER BY connector_id, connector_instance_id, stream, record_key
LIMIT ?
