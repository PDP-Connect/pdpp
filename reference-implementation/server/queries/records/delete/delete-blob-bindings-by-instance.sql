-- @terminator: exec
-- Connection-scoped, all-streams blob-binding erase keyed STRICTLY on one
-- connector_instance_id. By-instance sibling of delete-blob-bindings-by-stream.
-- Spec: add-owner-connection-delete-contract.
DELETE FROM blob_bindings WHERE connector_instance_id = ?
