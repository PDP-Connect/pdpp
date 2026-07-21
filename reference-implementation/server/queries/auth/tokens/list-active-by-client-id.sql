-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: tokens
-- @max_rows: 256
-- Active (non-revoked) bearer tokens issued against a given client_id, for the
-- owner-console per-client token drilldown (`GET /_ref/clients/{client_id}/
-- tokens?owner=true`). `token_id` is the LITERAL bearer and is consumed only
-- server-side to derive a non-reversible public token id and to match a
-- revoke handle; it MUST NOT be projected to any caller (see
-- server/auth.js::projectOwnerClientTokenRow). Bounded by the count of live
-- bearers for one operator client (small in practice; 256 leaves headroom).
-- Spec: openspec/changes/redesign-owner-console-product-experience/specs/
--       reference-surface-topology/spec.md
SELECT token_id, token_kind, created_at, expires_at
FROM tokens
WHERE client_id = ? AND revoked = 0
ORDER BY created_at DESC
