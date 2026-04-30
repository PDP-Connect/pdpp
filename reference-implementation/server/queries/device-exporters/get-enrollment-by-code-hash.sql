-- @terminator: one
SELECT enrollment_code_id, code_hash, owner_subject_id, device_id, status, created_at, expires_at, consumed_at, revoked_at
FROM device_enrollment_codes
WHERE code_hash = ?
