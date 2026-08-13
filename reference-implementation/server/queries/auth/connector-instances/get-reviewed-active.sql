-- @terminator: one
SELECT connector_instance_id
FROM connector_instances
WHERE connector_instance_id = ?
  AND connector_id = ?
  AND owner_subject_id = ?
  AND status = 'active'
LIMIT 1;
