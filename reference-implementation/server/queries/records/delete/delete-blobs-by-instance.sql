-- @terminator: exec
-- Connection-scoped blob-content erase keyed STRICTLY on one
-- connector_instance_id (blobs.connector_instance_id is NOT NULL). Deleted
-- AFTER blob_bindings in the same transaction so no binding outlives its blob.
-- The reference stores blobs per connection (not globally content-shared), so a
-- by-instance blob delete does not orphan a sibling connection's bindings.
-- Spec: add-owner-connection-delete-contract.
DELETE FROM blobs WHERE connector_instance_id = ?
