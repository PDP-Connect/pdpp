-- @terminator: exec
UPDATE connector_instances
SET status = 'revoked', revoked_at = ?, updated_at = ?
WHERE status <> 'revoked'
  AND connector_instance_id IN (
    SELECT connector_instance_id
    FROM device_source_instances
    WHERE device_id = ?
      AND connector_instance_id IS NOT NULL
  )
