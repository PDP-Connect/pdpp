-- @terminator: exec
INSERT INTO connector_instances(
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
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(owner_subject_id, connector_id, source_kind, source_binding_key)
DO UPDATE SET
  display_name = excluded.display_name,
  status = excluded.status,
  source_binding_json = excluded.source_binding_json,
  updated_at = excluded.updated_at,
  revoked_at = excluded.revoked_at;
