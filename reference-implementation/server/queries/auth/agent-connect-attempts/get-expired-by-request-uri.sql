-- @terminator: one
SELECT id
FROM agent_connect_attempts
WHERE request_uri = ?
  AND status = 'expired'
LIMIT 1
