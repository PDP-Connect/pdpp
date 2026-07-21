-- @terminator: exec
UPDATE connector_instance_credentials
SET
  status = 'rejected',
  rejected_at = ?,
  rejection_reason = ?,
  revoked_at = NULL
WHERE connector_instance_id = ?
  AND status <> 'revoked';
