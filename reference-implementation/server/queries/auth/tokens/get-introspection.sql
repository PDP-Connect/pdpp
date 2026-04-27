-- @terminator: one
SELECT t.token_id, t.grant_id, t.subject_id, t.client_id, t.token_kind, t.expires_at, t.revoked,
       g.status as grant_status, g.grant_json, g.trace_id, g.scenario_id,
       g.storage_binding_json
FROM tokens t
LEFT JOIN grants g ON t.grant_id = g.grant_id
WHERE t.token_id = ?
