-- @terminator: exec
UPDATE connector_instances
SET status = ?,
    updated_at = ?,
    revoked_at = ?
WHERE connector_instance_id = ?;
