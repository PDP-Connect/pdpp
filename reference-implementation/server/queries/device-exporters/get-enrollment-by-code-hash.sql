-- @terminator: one
SELECT enrollment_code_id, code_hash, owner_subject_id, connector_id, local_binding_id, display_name, device_id, status, created_at, expires_at, consumed_at, revoked_at
FROM device_enrollment_codes
WHERE code_hash = ?
