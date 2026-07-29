-- @terminator: exec
-- Erases connector_summary_evidence rows for a connector instance being hard
-- deleted, inside the same transaction as the rest of the deleteConnection
-- cascade. Spec: add-owner-connection-delete-contract.
DELETE FROM connector_summary_evidence WHERE connector_instance_id = ?
