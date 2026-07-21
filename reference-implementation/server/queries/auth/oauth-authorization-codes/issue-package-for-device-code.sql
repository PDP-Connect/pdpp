-- @terminator: exec
UPDATE oauth_authorization_codes
SET code = ?,
    grant_id = NULL,
    package_id = ?,
    token_id = ?,
    status = 'issued',
    issued_at = ?,
    expires_at = ?
WHERE device_code = ? AND status = 'pending'
