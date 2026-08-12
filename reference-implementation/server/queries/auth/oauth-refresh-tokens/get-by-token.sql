-- @terminator: one
SELECT refresh_token_hash, family_id, generation, parent_generation, client_id, grant_id,
       package_id, subject_id, status, created_at, expires_at, last_used_at,
       superseded_at, revoked_at
FROM oauth_refresh_tokens
WHERE refresh_token_hash = ?
