-- @terminator: exec
INSERT INTO grants(
  grant_id, subject_id, client_id, storage_binding_json, grant_json,
  access_mode, issued_at, expires_at, trace_id, scenario_id
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
