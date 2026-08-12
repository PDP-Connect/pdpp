-- @terminator: exec
DELETE FROM agent_connect_attempts
 WHERE status = 'denied'
    OR (status = 'approved' AND response_json IS NOT NULL AND expires_at_ms <= ?)
