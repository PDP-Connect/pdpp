-- @terminator: exec
UPDATE oauth_authorization_codes
SET status = 'expired'
WHERE device_code = ? AND status = 'pending'
