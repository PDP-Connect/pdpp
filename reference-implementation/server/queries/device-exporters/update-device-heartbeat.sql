-- @terminator: exec
UPDATE device_exporters
SET updated_at = ?,
    last_heartbeat_at = ?,
    agent_version = COALESCE(?, agent_version),
    last_error_json = ?
WHERE device_id = ?
  AND status = 'active'
