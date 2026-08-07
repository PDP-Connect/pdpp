-- @terminator: one
-- Read the current status of exactly one (run_id, connector_instance_id)
-- run_history row. Used by the record-ingest write path to fence a write
-- against a run that reached a terminal state (owner-cancelled, timed out)
-- while the write was already admitted into the per-connector-instance
-- write coordinator. `connector_instance_id` is required, not optional:
-- run_id alone is NOT globally unique (see run-history-writer.ts header) —
-- a bare `WHERE run_id = ?` could match a DIFFERENT connection's row that
-- happens to share this run_id. See harden-ingest-run-admission-fence.
SELECT status
FROM run_history
WHERE run_id = ?
  AND connector_instance_id = ?
