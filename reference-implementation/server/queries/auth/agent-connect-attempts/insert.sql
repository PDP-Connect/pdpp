-- @terminator: exec
INSERT INTO agent_connect_attempts(
  id, request_uri, client_id, polling_code_hash, status, approval_url, token_url,
  interval_seconds, created_at, expires_at_ms
) VALUES(?, ?, ?, ?, 'pending', ?, ?, 2, ?, ?)
