-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: oauth_clients
-- @max_rows: 256
-- Operator-issued dynamic clients owned by a specific subject. Used by
-- `GET /_ref/clients?owner=true` so the Tokens dashboard can list/revoke
-- only the credentials the requesting operator created. Bounded by the
-- count of dashboard-issued tokens for one operator (small in practice;
-- 256 leaves headroom for power users without becoming an unbounded scan).
-- Spec: openspec/changes/dcr-per-owner-token-with-revoke/specs/
--       reference-implementation-architecture/spec.md
SELECT client_id, client_secret, registration_mode, token_endpoint_auth_method, metadata_json, created_at, updated_at
FROM oauth_clients
WHERE registration_mode = 'dynamic'
  AND json_extract(metadata_json, '$.issuer_subject_id') = ?
ORDER BY created_at DESC
