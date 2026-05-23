-- @terminator: exec
INSERT INTO oauth_authorization_codes(
  id, device_code, client_id, redirect_uri, state, code_challenge,
  code_challenge_method, status, created_at, expires_at
) VALUES(?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
ON CONFLICT(device_code) DO UPDATE SET
  client_id = excluded.client_id,
  redirect_uri = excluded.redirect_uri,
  state = excluded.state,
  code_challenge = excluded.code_challenge,
  code_challenge_method = excluded.code_challenge_method,
  status = 'pending',
  code = NULL,
  grant_id = NULL,
  token_id = NULL,
  created_at = excluded.created_at,
  expires_at = excluded.expires_at,
  issued_at = NULL,
  consumed_at = NULL
