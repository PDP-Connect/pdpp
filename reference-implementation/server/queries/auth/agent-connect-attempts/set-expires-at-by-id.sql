-- @terminator: exec
UPDATE agent_connect_attempts
   SET expires_at_ms = ?
 WHERE id = ?
