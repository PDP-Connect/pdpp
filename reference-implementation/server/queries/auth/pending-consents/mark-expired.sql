-- @terminator: exec
UPDATE pending_consents
SET status = 'expired'
WHERE device_code = ? AND status = 'pending'
