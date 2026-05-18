-- @terminator: exec
-- Drop record_changes rows whose version is older than the configured
-- retention horizon. Bind order is
-- (connector_instance_id, stream, max_retained_version_inclusive).
DELETE FROM record_changes
WHERE connector_instance_id = ?
  AND stream = ?
  AND version <= ?
