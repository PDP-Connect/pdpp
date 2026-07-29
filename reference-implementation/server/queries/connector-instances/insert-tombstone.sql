-- @terminator: exec
-- Records that this connector-instance IDENTITY was owner-deleted. Run
-- inside the SAME cascade transaction as the connector_instances row
-- removal, immediately before it. Idempotent (ON CONFLICT DO NOTHING) on the
-- identity UNIQUE constraint: a repeat delete of an already-tombstoned
-- identity is a no-op here (the route-level repeat-delete guard already
-- refuses via connector_instance_not_found before this is ever reached).
-- Spec: openspec/changes/fix-owner-delete-resurrection.
INSERT INTO connector_instance_tombstones(
  connector_instance_id,
  owner_subject_id,
  connector_id,
  source_kind,
  source_binding_key,
  deleted_at
)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(owner_subject_id, connector_id, source_kind, source_binding_key) DO NOTHING;
