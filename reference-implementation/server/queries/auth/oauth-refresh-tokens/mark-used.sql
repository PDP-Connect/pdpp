-- @terminator: exec
UPDATE oauth_refresh_tokens
SET last_used_at = ?
WHERE refresh_token_hash = ? AND status = 'active'
