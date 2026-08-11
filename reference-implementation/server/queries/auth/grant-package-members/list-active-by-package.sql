-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_package_members
-- @max_rows: 256
SELECT gm.package_id, gm.grant_id, gm.token_id, gm.source_json, gm.status, gm.added_at, gm.revoked_at,
       g.status AS grant_status, g.grant_json, g.storage_binding_json,
       g.grant_id AS persisted_grant_id, g.subject_id AS grant_subject_id,
       g.client_id AS grant_client_id, g.access_mode AS grant_access_mode,
       g.expires_at AS grant_expires_at,
       t.grant_id AS token_grant_id, t.subject_id AS token_subject_id,
       t.client_id AS token_client_id, t.revoked AS token_revoked,
       t.expires_at AS token_expires_at
FROM grant_package_members gm
JOIN grants g ON gm.grant_id = g.grant_id
JOIN tokens t ON gm.token_id = t.token_id
WHERE gm.package_id = ?
  AND gm.status = 'active'
ORDER BY gm.added_at, gm.grant_id
