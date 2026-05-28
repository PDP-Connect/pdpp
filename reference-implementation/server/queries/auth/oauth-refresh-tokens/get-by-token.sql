-- @terminator: one
SELECT refresh_token_hash, client_id, grant_id, package_id, subject_id, status, created_at,
       expires_at, last_used_at, revoked_at
FROM oauth_refresh_tokens
WHERE refresh_token_hash = ?
