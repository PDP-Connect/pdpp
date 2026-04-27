-- @terminator: one
-- The lowest retained version in record_changes for this
-- (connector_id, stream). Used to detect a stale changes_since cursor
-- (older than retained history) and force a full re-sync.
SELECT MIN(version) AS min_version
FROM record_changes
WHERE connector_id = ? AND stream = ?
