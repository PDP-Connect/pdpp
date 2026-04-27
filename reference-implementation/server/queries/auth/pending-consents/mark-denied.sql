-- @terminator: exec
UPDATE pending_consents
SET status = 'denied', denied_at = ?
WHERE device_code = ? AND status = 'pending'
