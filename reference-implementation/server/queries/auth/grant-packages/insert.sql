-- @terminator: exec
INSERT INTO grant_packages(
  package_id, subject_id, client_id, status, package_json,
  trace_id, scenario_id, created_at, approved_at, revoked_at
)
VALUES(?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL)
