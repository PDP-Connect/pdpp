-- @terminator: exec
-- Owner self-export bearers carry no grant (they're not delegations) but DO
-- carry a client_id when issued via per-token DCR (the device flow runs
-- against a uniquely-registered client per credential — see
-- openspec/changes/dcr-per-owner-token-with-revoke/). Recording client_id
-- here lets DELETE /oauth/register/{client_id} cascade-revoke the bearer.
-- Pre-DCR-per-token issuance still works: callers that pass NULL just
-- behave the same as before.
INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
VALUES(?, NULL, ?, ?, 'owner', ?)
