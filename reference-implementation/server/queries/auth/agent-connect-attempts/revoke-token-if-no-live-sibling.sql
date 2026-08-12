-- @terminator: exec
UPDATE tokens
SET revoked = 1
WHERE token_id = ?
  AND revoked = 0
  AND NOT EXISTS (
    SELECT 1
    FROM agent_connect_attempts
    WHERE request_uri = ?
      AND id != ?
      AND status IN ('pending', 'approved')
      AND expires_at_ms > ?
  )
