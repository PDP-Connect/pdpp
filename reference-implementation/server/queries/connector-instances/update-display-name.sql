-- @terminator: exec
UPDATE connector_instances
SET display_name = ?,
    updated_at = ?
WHERE connector_instance_id = ?
  AND owner_subject_id = ?;
