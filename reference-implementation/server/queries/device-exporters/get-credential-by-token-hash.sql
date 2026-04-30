-- @terminator: one
SELECT credential_id, device_id, token_hash, status, created_at, last_used_at, revoked_at
FROM device_ingest_credentials
WHERE token_hash = ?
