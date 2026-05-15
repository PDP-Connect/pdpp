-- @terminator: many
-- @cursor_field: connector_instance_id
SELECT
  rowid,
  connector_instance_id,
  owner_subject_id,
  connector_id,
  display_name,
  status,
  source_kind,
  source_binding_key,
  source_binding_json,
  created_at,
  updated_at,
  revoked_at
FROM connector_instances
WHERE owner_subject_id = ?
ORDER BY connector_id ASC, created_at ASC, connector_instance_id ASC
LIMIT ?;
