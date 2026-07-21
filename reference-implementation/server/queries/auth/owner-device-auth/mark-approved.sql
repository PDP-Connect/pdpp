-- @terminator: exec
UPDATE owner_device_auth
SET status = 'approved',
    subject_id = ?,
    token_id = ?,
    approved_at = ?
WHERE device_code = ?
