-- @terminator: one
-- Probe whether the provenance anchor for a current record row still
-- exists: the record_changes row for this
-- (connector_instance_id, stream, record_key) at the exact version the
-- current `records` row carries. History pruning by stream-global version
-- cutoff can remove the only retained change row for a still-current,
-- unchanged record (a cold key whose anchor falls below the horizon while a
-- hot key churns the stream forward). When this returns no row, the current
-- projection is unanchored and an otherwise-no-op reingest must self-heal by
-- appending a fresh anchor instead of silently suppressing the write.
-- Bind order is (connector_instance_id, stream, record_key, version).
SELECT version
FROM record_changes
WHERE connector_instance_id = ?
  AND stream = ?
  AND record_key = ?
  AND version = ?
