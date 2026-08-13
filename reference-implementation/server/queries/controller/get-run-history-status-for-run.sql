-- @terminator: one
SELECT status
  FROM run_history
 WHERE run_id = ?
   AND connector_instance_id = ?
 LIMIT 1;
