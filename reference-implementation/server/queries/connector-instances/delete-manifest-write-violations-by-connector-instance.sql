-- @terminator: exec
-- Erases manifest-write-violation rows for a connector instance being hard
-- deleted, inside the same transaction as the rest of the deleteConnection
-- cascade. Spec: add-owner-connection-delete-contract.
DELETE FROM manifest_write_violations WHERE connector_instance_id = ?
