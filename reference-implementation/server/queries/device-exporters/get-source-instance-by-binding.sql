-- @terminator: one
SELECT source_instance_id, device_id, connector_id, local_binding_id, display_name, status, created_at, updated_at, revoked_at
FROM device_source_instances
WHERE device_id = ?
  AND connector_id = ?
  AND local_binding_id = ?
