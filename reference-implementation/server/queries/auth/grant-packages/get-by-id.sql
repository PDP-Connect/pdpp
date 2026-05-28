-- @terminator: one
SELECT package_id, subject_id, client_id, status, package_json,
       trace_id, scenario_id, created_at, approved_at, revoked_at
FROM grant_packages
WHERE package_id = ?
