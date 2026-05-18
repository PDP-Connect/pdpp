-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: device_source_instances
-- @max_rows: 2048
SELECT source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, last_error_json, created_at, updated_at, revoked_at
FROM device_source_instances
WHERE (? IS NULL OR device_id = ?)
ORDER BY device_id ASC, created_at DESC, source_instance_id ASC
