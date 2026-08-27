-- @terminator: exec
UPDATE connector_instance_credentials
SET
  status = 'revoked',
  revoked_at = ?,
  rejected_at = NULL,
  rejection_reason = NULL,
  state_change_json = ?
WHERE connector_instance_id = ?
  AND status <> 'revoked';
