-- @terminator: one
SELECT id, device_code, client_id, redirect_uri, state, status, expires_at
FROM oauth_authorization_codes
WHERE device_code = ?
