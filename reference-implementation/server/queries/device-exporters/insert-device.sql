-- @terminator: exec
INSERT INTO device_exporters(
  device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
