-- @terminator: exec
-- Connection-scoped, all-streams record-change history erase keyed STRICTLY on
-- one connector_instance_id. By-instance sibling of
-- delete-record-changes-by-stream. Spec: add-owner-connection-delete-contract.
DELETE FROM record_changes WHERE connector_instance_id = ?
