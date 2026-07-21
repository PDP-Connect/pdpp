-- @terminator: exec
UPDATE device_ingest_credentials
SET status = 'revoked', revoked_at = ?
WHERE device_id = ?
  AND status <> 'revoked'
