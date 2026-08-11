-- @terminator: one
SELECT status
FROM connector_instances
WHERE owner_subject_id = ?
  AND connector_instance_id = ?
  AND connector_id = ?
LIMIT 1
