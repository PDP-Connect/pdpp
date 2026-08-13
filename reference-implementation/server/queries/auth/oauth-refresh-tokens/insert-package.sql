-- @terminator: exec
INSERT INTO oauth_refresh_tokens(
  refresh_token_hash, family_id, generation, parent_generation, client_id,
  grant_id, package_id, subject_id, status, created_at, expires_at,
  last_used_at, superseded_at, revoked_at
)
VALUES(?, ?, ?, ?, ?, NULL, ?, ?, 'active', ?, ?, NULL, NULL, NULL)
