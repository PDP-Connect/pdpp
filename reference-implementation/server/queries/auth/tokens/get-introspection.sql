-- @terminator: one
SELECT t.token_id, t.grant_id, t.package_id, t.subject_id, t.client_id, t.token_kind, t.expires_at, t.revoked,
       g.status as grant_status, g.grant_json, g.trace_id, g.scenario_id,
       gp.status as package_status, gp.package_json, gp.trace_id as package_trace_id, gp.scenario_id as package_scenario_id,
       g.storage_binding_json
FROM tokens t
LEFT JOIN grants g ON t.grant_id = g.grant_id
LEFT JOIN grant_packages gp ON t.package_id = gp.package_id
WHERE t.token_id = ?
