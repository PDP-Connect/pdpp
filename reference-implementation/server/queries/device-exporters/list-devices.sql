-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: device_exporters
-- @max_rows: 512
SELECT device_id, owner_subject_id, display_name, status, agent_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at
FROM device_exporters
WHERE owner_subject_id = ?
ORDER BY created_at DESC, device_id ASC
