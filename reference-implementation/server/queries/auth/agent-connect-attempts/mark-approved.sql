-- @terminator: exec
UPDATE agent_connect_attempts
   SET status = 'approved',
       completed_at = ?,
       token = ?,
       grant_json = ?,
       grant_id = ?
 WHERE request_uri = ?
   AND status = 'pending'
