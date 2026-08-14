-- @terminator: exec
UPDATE oauth_refresh_tokens
SET status = 'revoked',
    revoked_at = ?
WHERE family_id = ? AND status <> 'revoked'
