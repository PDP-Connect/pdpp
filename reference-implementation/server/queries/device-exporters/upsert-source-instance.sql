-- @terminator: exec
INSERT INTO device_source_instances(
  source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, created_at, updated_at, revoked_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(device_id, connector_id, local_binding_id) DO UPDATE SET
  source_instance_id = excluded.source_instance_id,
  connector_instance_id = excluded.connector_instance_id,
  display_name = excluded.display_name,
  status = excluded.status,
  last_error_json = excluded.last_error_json,
  updated_at = excluded.updated_at,
  revoked_at = excluded.revoked_at
