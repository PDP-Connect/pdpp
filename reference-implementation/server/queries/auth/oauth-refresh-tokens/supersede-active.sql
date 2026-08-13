-- @terminator: exec
UPDATE oauth_refresh_tokens
SET status = 'superseded',
    last_used_at = ?,
    superseded_at = ?
WHERE refresh_token_hash = ? AND status = 'active'
