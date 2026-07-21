-- @terminator: exec
INSERT INTO oauth_clients(
  client_id, registration_mode, token_endpoint_auth_method,
  client_secret, metadata_json, created_at, updated_at
) VALUES(?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(client_id) DO UPDATE SET
  registration_mode = excluded.registration_mode,
  token_endpoint_auth_method = excluded.token_endpoint_auth_method,
  client_secret = excluded.client_secret,
  metadata_json = excluded.metadata_json,
  updated_at = excluded.updated_at
