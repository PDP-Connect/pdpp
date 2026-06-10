-- @terminator: exec
DELETE FROM connector_instance_credentials
WHERE connector_instance_id = ?;
