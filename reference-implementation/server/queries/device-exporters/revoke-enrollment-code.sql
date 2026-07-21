-- @terminator: exec
UPDATE device_enrollment_codes
SET status = 'revoked', revoked_at = ?
WHERE enrollment_code_id = ?
  AND status = 'pending'
