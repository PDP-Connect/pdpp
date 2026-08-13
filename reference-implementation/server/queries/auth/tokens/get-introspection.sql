-- @terminator: one
SELECT t.token_id, t.grant_id, t.package_id, t.refresh_family_id,
       CASE
         WHEN t.refresh_family_id IS NULL THEN NULL
         ELSE EXISTS(
           SELECT 1
           FROM oauth_refresh_tokens rt
           WHERE rt.family_id = t.refresh_family_id
             AND rt.status = 'active'
             AND rt.revoked_at IS NULL
         )
       END AS refresh_family_active,
       t.subject_id, t.client_id, t.token_kind, t.expires_at, t.revoked,
       g.status as grant_status, g.grant_json, g.trace_id, g.scenario_id,
       g.grant_id AS persisted_grant_id, g.subject_id AS grant_subject_id,
       g.client_id AS grant_client_id, g.access_mode AS grant_access_mode,
       g.expires_at AS grant_expires_at,
       gp.status as package_status, gp.package_json, gp.trace_id as package_trace_id, gp.scenario_id as package_scenario_id,
       gp.package_id AS persisted_package_id, gp.subject_id AS package_subject_id,
       gp.client_id AS package_client_id,
       g.storage_binding_json
FROM tokens t
LEFT JOIN grants g ON t.grant_id = g.grant_id
LEFT JOIN grant_packages gp ON t.package_id = gp.package_id
WHERE t.token_id = ?
