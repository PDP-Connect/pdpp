-- @terminator: exec
-- Delete a registered OAuth client by id. Used by `DELETE /oauth/register/{client_id}`
-- (RFC 7592). The route layer enforces that only `registration_mode='dynamic'`
-- clients can be deleted and only by the operator who registered them; this
-- statement just executes the row removal once auth/cascade logic has run.
DELETE FROM oauth_clients WHERE client_id = ?
