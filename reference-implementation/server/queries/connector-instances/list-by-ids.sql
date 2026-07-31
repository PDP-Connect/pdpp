-- @terminator: many
-- @cursor_field: connector_instance_id
-- The JSON array is one bounded caller-supplied id set (the maintenance
-- sweep's page of connector_instance_ids). The LIMIT is that same page's
-- distinct-id count, so this read can never return more rows than its
-- explicitly bounded input.
SELECT
  connector_instances.rowid AS rowid,
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
JOIN json_each(?) AS page_instance_ids ON page_instance_ids.value = connector_instances.connector_instance_id
WHERE owner_subject_id = ?
ORDER BY connector_instance_id ASC
LIMIT ?;
