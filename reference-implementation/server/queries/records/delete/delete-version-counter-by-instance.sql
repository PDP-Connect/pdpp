-- @terminator: exec
-- Connection-scoped, all-streams version-counter erase keyed STRICTLY on one
-- connector_instance_id. By-instance sibling of
-- delete-version-counter-by-stream. Spec: add-owner-connection-delete-contract.
DELETE FROM version_counter WHERE connector_instance_id = ?
