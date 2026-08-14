-- @terminator: exec
UPDATE agent_connect_attempts
   SET status = ?,
       completed_at = ?
 WHERE request_uri = ?
   AND status = 'pending'
