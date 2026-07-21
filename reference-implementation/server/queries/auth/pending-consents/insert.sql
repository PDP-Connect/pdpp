-- @terminator: exec
INSERT INTO pending_consents(
  device_code, user_code, params_json, status,
  request_id, trace_id, scenario_id, created_at, expires_at, approval_id
) VALUES(?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
