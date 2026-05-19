-- @terminator: one
SELECT device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at
FROM device_exporters
WHERE device_id = ?
