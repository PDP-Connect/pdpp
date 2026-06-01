-- @terminator: exec
-- Connection-scoped, all-streams records erase keyed STRICTLY on one
-- connector_instance_id. The by-instance sibling of delete-records-by-stream;
-- it never widens to connector_id, so deleting one connection leaves sibling
-- connections of the same connector type intact. Used by the owner-agent
-- connection-delete cascade. Spec: add-owner-connection-delete-contract (I1/I2).
DELETE FROM records WHERE connector_instance_id = ?
