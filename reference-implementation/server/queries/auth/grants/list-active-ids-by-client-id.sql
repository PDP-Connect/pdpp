-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grants
-- @max_rows: 1024
-- Active grant ids tied to a given client_id. Used by the cascade-revoke
-- step of `DELETE /oauth/register/{client_id}` (RFC 7592 client deletion):
-- we look up every active grant for the client and revoke each via the
-- existing `revokeGrant` codepath so spine events fire correctly.
-- Bounded by the active-grants-per-client population. Dashboard-issued owner
-- self-export tokens do not have grant rows; they are revoked separately via
-- auth/tokens/revoke-by-client-id.sql. 1024 covers pathological third-party
-- client cases without becoming unbounded.
SELECT grant_id
FROM grants
WHERE client_id = ? AND status = 'active'
ORDER BY issued_at ASC
