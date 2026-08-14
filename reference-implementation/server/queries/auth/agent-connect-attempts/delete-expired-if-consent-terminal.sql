-- @terminator: exec
DELETE FROM agent_connect_attempts
WHERE id = ?
  AND status = 'expired'
  AND NOT EXISTS (
    SELECT 1
    FROM pending_consents
    WHERE device_code = ?
      AND status IN ('pending', 'approving', 'approved')
  )
