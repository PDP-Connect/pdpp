-- @terminator: exec
-- Drop record_changes rows whose version is older than the configured
-- retention horizon, EXCEPT the row that anchors a still-current `records`
-- row for the same key. Bind order is
-- (connector_instance_id, stream, max_retained_version_inclusive).
--
-- Anchor preservation: a current `records` row at version V is projected from
-- the `record_changes` row at the same `(connector_instance_id, stream,
-- record_key, version)`. A pure stream-version cutoff (`version <= ?`) deletes
-- that anchor whenever OTHER keys advance the per-stream version past
-- `V + PDPP_CHANGE_HISTORY_LIMIT`, stranding the unchanged current row as
-- `unresolved_pruned`. The `NOT EXISTS` clause keeps exactly the anchor row
-- (one per live key) so bounded pruning can never orphan the current
-- projection. This is the load-bearing fix for the live Chase / USAA /
-- reddit / github current-projection drift.
DELETE FROM record_changes
WHERE connector_instance_id = ?
  AND stream = ?
  AND version <= ?
  AND NOT EXISTS (
    SELECT 1
      FROM records r
     WHERE r.connector_instance_id = record_changes.connector_instance_id
       AND r.stream = record_changes.stream
       AND r.record_key = record_changes.record_key
       AND r.version = record_changes.version
  )
