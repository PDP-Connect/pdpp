-- @terminator: exec
UPDATE device_source_instances
SET updated_at = ?,
    last_error_json = ?
WHERE device_id = ?
  AND source_instance_id = ?
  AND status = 'active'
