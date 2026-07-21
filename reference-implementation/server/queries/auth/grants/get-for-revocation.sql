-- @terminator: one
SELECT client_id, subject_id, trace_id, scenario_id, grant_json, storage_binding_json
FROM grants
WHERE grant_id = ?
