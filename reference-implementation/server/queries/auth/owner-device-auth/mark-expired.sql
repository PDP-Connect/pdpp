-- @terminator: exec
UPDATE owner_device_auth
SET status = 'expired'
WHERE device_code = ? AND status = 'pending'
