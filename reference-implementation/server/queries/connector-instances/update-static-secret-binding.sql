-- @terminator: exec
UPDATE connector_instances
SET source_binding_key = ?,
    source_binding_json = ?,
    updated_at = ?
WHERE connector_instance_id = ?
  AND owner_subject_id = ?
  AND connector_id = ?
  AND status IN ('active', 'draft', 'paused');
