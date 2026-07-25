-- @terminator: exec
-- ON CONFLICT DO NOTHING: device_id is deterministic per enrollment code (see
-- fix-enroll-pending-code-partial-write-idempotency design D5), so a
-- concurrent retry of the same pending code racing another first attempt
-- converges on one device row instead of raising a duplicate-key error.
INSERT INTO device_exporters(
  device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(device_id) DO NOTHING
