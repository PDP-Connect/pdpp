-- @terminator: one
SELECT
  connector_instance_id,
  canonical_connector_instance_id,
  owner_subject_id,
  reason,
  evidence,
  grouped_by,
  grouped_at
FROM connector_instance_groups
WHERE connector_instance_id = ?
LIMIT 1;
