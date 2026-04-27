-- @terminator: exec
UPDATE owner_device_auth
SET status = 'denied', denied_at = ?
WHERE device_code = ? AND status = 'pending'
