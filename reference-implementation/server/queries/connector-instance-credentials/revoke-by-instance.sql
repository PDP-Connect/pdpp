-- @terminator: exec
UPDATE connector_instance_credentials
SET status = 'revoked', revoked_at = ?
WHERE connector_instance_id = ?
  AND status <> 'revoked';
