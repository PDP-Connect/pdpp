-- @terminator: one
SELECT source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, last_heartbeat_at, last_heartbeat_status, records_pending, outbox_diagnostics_json, manifest_generation, created_at, updated_at, revoked_at
FROM device_source_instances
WHERE device_id = ?
  AND connector_id = ?
  AND local_binding_id = ?
