-- @terminator: exec
-- Groups a fragment connector instance under a canonical connector instance
-- as an alias/read-model row -- it never rewrites connector_instances,
-- records, or any other table. Idempotent: re-running with the SAME
-- (connector_instance_id, canonical_connector_instance_id, reason) pair is a
-- no-op; re-running with a DIFFERENT canonical id or reason for the same
-- fragment updates the row in place (a fragment has at most one canonical
-- target at a time). See server/connector-instance-canonicalization.ts.
INSERT INTO connector_instance_groups(
  connector_instance_id,
  canonical_connector_instance_id,
  owner_subject_id,
  reason,
  evidence,
  grouped_by,
  grouped_at
)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id) DO UPDATE SET
  canonical_connector_instance_id = excluded.canonical_connector_instance_id,
  reason = excluded.reason,
  evidence = excluded.evidence,
  grouped_by = excluded.grouped_by,
  grouped_at = excluded.grouped_at
WHERE connector_instance_groups.canonical_connector_instance_id <> excluded.canonical_connector_instance_id
   OR connector_instance_groups.reason <> excluded.reason;
