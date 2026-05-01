-- @terminator: exec
INSERT INTO device_ingest_credentials(
  credential_id, device_id, token_hash, status, created_at, last_used_at, revoked_at
) VALUES(?, ?, ?, ?, ?, ?, ?)
