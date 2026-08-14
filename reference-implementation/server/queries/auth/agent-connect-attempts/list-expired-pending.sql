-- @terminator: many
-- @cursor_field: rowid
SELECT rowid,
       *
FROM agent_connect_attempts
WHERE status = 'pending'
  AND expires_at_ms <= ?
ORDER BY rowid
LIMIT ?
