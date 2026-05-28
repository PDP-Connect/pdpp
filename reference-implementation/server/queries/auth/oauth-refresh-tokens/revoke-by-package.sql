-- @terminator: exec
UPDATE oauth_refresh_tokens
SET status = 'revoked',
    revoked_at = ?
WHERE package_id = ? AND status = 'active'
