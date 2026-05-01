-- @terminator: exec
UPDATE device_exporters
SET status = 'revoked', revoked_at = ?, updated_at = ?
WHERE device_id = ?
