-- @terminator: one
SELECT
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
  AND connector_id = ?
  AND source_kind = ?
  AND source_binding_key = ?
LIMIT 1;
