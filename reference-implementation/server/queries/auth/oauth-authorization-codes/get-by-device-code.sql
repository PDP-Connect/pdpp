-- @terminator: one
SELECT id, device_code, client_id, redirect_uri, state, status, expires_at,
       code AS issued_code, grant_id, package_id, token_id, issued_at, consumed_at
FROM oauth_authorization_codes
WHERE device_code = ?
