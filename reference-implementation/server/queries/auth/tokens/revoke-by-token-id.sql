-- @terminator: exec
-- Per-token revoke for the owner-console token drilldown (`DELETE
-- /_ref/clients/{client_id}/tokens/{token_id_public}`). Revokes exactly ONE
-- bearer without deleting the client or touching its other tokens. The caller
-- resolves the literal `token_id` from the non-bearer public id server-side,
-- then scopes the revoke to (token_id, client_id) so a public id minted for
-- one client can never revoke another client's token. Idempotent.
UPDATE tokens SET revoked = 1 WHERE token_id = ? AND client_id = ? AND revoked = 0
