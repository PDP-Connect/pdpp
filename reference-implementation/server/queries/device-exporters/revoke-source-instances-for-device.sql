-- @terminator: exec
UPDATE device_source_instances
SET status = 'revoked', revoked_at = ?, updated_at = ?
WHERE device_id = ?
  AND status <> 'revoked'
