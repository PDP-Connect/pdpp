-- @terminator: exec
UPDATE device_source_instances
SET updated_at = ?,
    last_error_json = ?,
    last_heartbeat_at = ?,
    last_heartbeat_status = ?,
    records_pending = ?,
    outbox_diagnostics_json = ?
WHERE device_id = ?
  AND source_instance_id = ?
  AND status = 'active'
