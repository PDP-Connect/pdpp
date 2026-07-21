-- @terminator: exec
UPDATE owner_device_auth
SET last_polled_at = ?
WHERE device_code = ?
