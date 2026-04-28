-- @terminator: one
-- Count of currently-active bearer tokens issued against a given client_id.
-- Includes owner self-export bearers (owner device flow -> tokens row, no
-- grant) and grant-bound client bearers (consent flow -> grant + token).
-- Used by `GET /_ref/clients?owner=true` to surface per-credential liveness
-- on the Tokens dashboard.
SELECT COUNT(*) AS active_token_count
FROM tokens
WHERE client_id = ? AND revoked = 0
