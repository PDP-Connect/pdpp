-- @terminator: many
-- @cursor_field: connector_instance_id
-- Bounded by the small_enumeration_table contract: one owner's grouped
-- fragments are expected to be a tiny set (tens, not thousands) relative to
-- their connector_instances inventory. See
-- server/connector-instance-canonicalization.ts for the resolver that
-- consumes this as a full-map preload, never a per-row lookup in a hot path.
SELECT
  connector_instance_id,
  canonical_connector_instance_id,
  owner_subject_id,
  reason,
  evidence,
  grouped_by,
  grouped_at
FROM connector_instance_groups
WHERE owner_subject_id = ?
ORDER BY connector_instance_id ASC
LIMIT ?;
