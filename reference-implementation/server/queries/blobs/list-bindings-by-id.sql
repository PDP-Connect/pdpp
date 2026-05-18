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
-- The result is bounded per-blob in practice (a content-addressed
-- blob is referenced by the records that emit those bytes — usually
-- one, sometimes a small handful when the same payload is shared).
-- The wrapper's `LIMIT ?` placeholder caps the read defensively;
-- the caller passes a domain-appropriate limit.
SELECT 0 AS id, connector_id, connector_instance_id, stream, record_key
FROM blob_bindings
WHERE blob_id = ?
UNION
SELECT 0 AS id, connector_id, NULL AS connector_instance_id, stream, record_key
FROM blobs
WHERE blob_id = ?
ORDER BY connector_id, connector_instance_id, stream, record_key
LIMIT ?
