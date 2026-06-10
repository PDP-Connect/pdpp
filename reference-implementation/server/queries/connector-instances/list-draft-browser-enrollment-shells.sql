-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: connector_instances
-- @max_rows: 256
-- Draft browser-enrollment shells (source_binding_json.kind =
-- 'browser_enrollment_shell'). Bounded because shells are short-lived
-- (2-hour TTL) and abandoned shells are swept to revoked at creation time
-- or by the retirement sweep; no owner accumulates more than a handful.
-- Used exclusively by the TTL retirement sweep; not a dashboard read surface.
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
WHERE status = 'draft'
  AND json_extract(source_binding_json, '$.kind') = 'browser_enrollment_shell'
ORDER BY created_at ASC, connector_instance_id ASC
