-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: connector_instances
-- @max_rows: 256
-- Browser-enrollment shells (source_binding_json.kind =
-- 'browser_enrollment_shell') that have not yet resolved to a real source
-- binding. Bounded because shells are short-lived (2-hour TTL) and abandoned
-- shells are swept explicitly or by the retirement sweep; no owner should
-- accumulate more than a handful.
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
WHERE status IN ('draft', 'active')
  AND json_extract(source_binding_json, '$.kind') = 'browser_enrollment_shell'
ORDER BY created_at ASC, connector_instance_id ASC
LIMIT 256
