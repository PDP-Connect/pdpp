-- @terminator: exec
INSERT INTO device_enrollment_codes(
  enrollment_code_id, code_hash, owner_subject_id, device_id, status, created_at, expires_at, consumed_at, revoked_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
