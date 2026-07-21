-- @terminator: exec
UPDATE device_ingest_credentials
SET last_used_at = ?
WHERE credential_id = ?
