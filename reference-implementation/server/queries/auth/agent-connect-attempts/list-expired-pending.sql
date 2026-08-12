-- @terminator: many
-- @cursor_field: id
SELECT *
FROM agent_connect_attempts
WHERE status = 'pending'
  AND expires_at_ms <= ?
ORDER BY id
LIMIT ?
