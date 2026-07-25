-- @terminator: one
SELECT
  connector_instance_id,
  owner_subject_id,
  connector_id,
  source_kind,
  source_binding_key,
  deleted_at
FROM connector_instance_tombstones
WHERE owner_subject_id = ?
  AND connector_id = ?
  AND source_kind = ?
  AND source_binding_key = ?
LIMIT 1;
