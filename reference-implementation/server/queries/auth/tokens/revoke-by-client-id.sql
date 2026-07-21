-- @terminator: exec
-- Cascade-revoke step for `DELETE /oauth/register/{client_id}` (RFC 7592):
-- mark every non-revoked token issued against the deleted client as revoked
-- so subsequent `POST /introspect` returns active=false. Idempotent.
UPDATE tokens SET revoked = 1 WHERE client_id = ? AND revoked = 0
