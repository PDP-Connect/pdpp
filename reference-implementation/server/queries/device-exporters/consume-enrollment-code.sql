-- @terminator: exec
UPDATE device_enrollment_codes
SET status = 'consumed', device_id = ?, consumed_at = ?
WHERE enrollment_code_id = ?
  AND status = 'pending'
