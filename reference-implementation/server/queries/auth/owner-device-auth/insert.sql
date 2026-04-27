-- @terminator: exec
INSERT INTO owner_device_auth(
  device_code, user_code, client_id, status, interval_seconds,
  created_at, expires_at, request_id, trace_id, scenario_id
) VALUES(?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
