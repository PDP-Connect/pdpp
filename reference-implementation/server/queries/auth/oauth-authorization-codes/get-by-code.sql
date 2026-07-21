-- @terminator: one
SELECT id, code, client_id, redirect_uri, code_challenge, code_challenge_method,
       status, grant_id, package_id, token_id, expires_at, consumed_at
FROM oauth_authorization_codes
WHERE code = ?
