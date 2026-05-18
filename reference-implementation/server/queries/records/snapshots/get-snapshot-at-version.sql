-- @terminator: one
-- Latest record_changes row at-or-before the requested version, used by
-- `getSnapshotAtVersion` to materialize the visible state of a record
-- at a specific point in change-log history. Bind order is
-- (connector_instance_id, stream, record_key, version).
SELECT record_json, emitted_at, deleted, deleted_at, version
FROM record_changes
WHERE connector_instance_id = ?
  AND stream = ?
  AND record_key = ?
  AND version <= ?
ORDER BY version DESC
LIMIT 1
