-- @terminator: exec
DELETE FROM agent_connect_attempts
 WHERE status IN ('denied', 'expired')
    OR (status = 'pending' AND expires_at_ms <= ?)
    OR (status = 'approved' AND response_json IS NOT NULL AND expires_at_ms <= ?)
