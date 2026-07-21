-- @terminator: exec
UPDATE pending_consents
SET last_polled_at = ?
WHERE device_code = ?
