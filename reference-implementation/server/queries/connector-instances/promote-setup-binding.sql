-- @terminator: exec
UPDATE connector_instances
SET source_binding_json = ?,
    status = ?,
    updated_at = ?
WHERE connector_instance_id = ?
  AND status = 'draft'
  AND json_extract(source_binding_json, '$.kind') = ?;
