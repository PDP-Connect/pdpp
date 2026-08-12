-- @terminator: exec
UPDATE agent_connect_attempts
   SET status = 'expired',
       completed_at = ?
 WHERE id = ?
   AND status IN ('pending', 'expired')
