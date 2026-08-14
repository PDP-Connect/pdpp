-- @terminator: exec
UPDATE agent_connect_attempts
   SET response_json = ?
 WHERE id = ?
   AND status = 'approved'
   AND response_json IS NULL
