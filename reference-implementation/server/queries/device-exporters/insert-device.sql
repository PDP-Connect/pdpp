-- @terminator: exec
-- ON CONFLICT DO NOTHING: device_id is generated fresh (randomBytes-derived)
-- per enroll attempt, so a collision here is not expected in practice; this
-- guards the caller against a duplicate-key error rather than encoding any
-- identity-convergence guarantee — the real convergence guarantee for
-- concurrent/repeat enrollment of the same binding lives in
-- resolveOrCreateEnrollmentDevice (design D6,
-- fix-enroll-stable-binding-identity-key), which this query's own callers do
-- not include.
INSERT INTO device_exporters(
  device_id, owner_subject_id, display_name, status, agent_version, collector_protocol_version, last_heartbeat_at, last_error_json, created_at, updated_at, revoked_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(device_id) DO NOTHING
