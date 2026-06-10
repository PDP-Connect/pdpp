-- @terminator: exec
INSERT INTO oauth_refresh_tokens(
  refresh_token_hash, client_id, grant_id, subject_id, status,
  created_at, expires_at, last_used_at, revoked_at
)
VALUES(?, ?, ?, ?, 'active', ?, ?, NULL, NULL)
