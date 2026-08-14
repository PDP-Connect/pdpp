-- @terminator: one
SELECT grant_id AS persisted_grant_id, subject_id AS grant_subject_id,
       client_id AS grant_client_id, access_mode AS grant_access_mode,
       expires_at AS grant_expires_at,
       grant_id, subject_id, client_id, access_mode, expires_at,
       consumed, status, trace_id, scenario_id, grant_json, storage_binding_json
FROM grants
WHERE grant_id = ?
