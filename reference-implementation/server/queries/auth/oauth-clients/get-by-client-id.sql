-- @terminator: one
SELECT client_id, registration_mode, token_endpoint_auth_method, client_secret, metadata_json, created_at, updated_at
FROM oauth_clients
WHERE client_id = ?
