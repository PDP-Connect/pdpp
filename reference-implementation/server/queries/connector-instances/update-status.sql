-- @terminator: exec
UPDATE connector_instances
SET status = ?,
    updated_at = CASE WHEN ? = 'revoked' AND status = 'revoked' THEN updated_at ELSE ? END,
    revoked_at = CASE WHEN ? = 'revoked' THEN COALESCE(revoked_at, ?) ELSE ? END
WHERE connector_instance_id = ?;
