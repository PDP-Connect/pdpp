-- @terminator: exec
-- Finalize the run-grain row at the terminal spine event
-- (run.completed/run.failed/run.cancelled). Only transitions a row still
-- in `running` state, so a retried/duplicate terminal emission for the
-- same (run_id, connector_instance_id) is a no-op (idempotent finalize).
-- If no started row exists (the `run.started` write raced or was lost),
-- this UPDATE affects zero rows; the caller falls back to
-- insert-finalized directly. `AND connector_instance_id = ?` is required,
-- not optional: run_id alone is NOT globally unique (two different
-- connections can independently mint the same run_id — see
-- openspec/changes/run-history-backfill-list-cutover), so a bare
-- `WHERE run_id = ? AND status = 'running'` could finalize a DIFFERENT
-- connection's still-running row that happens to share this run_id. See
-- openspec/changes/generalize-run-history-write-authority.
UPDATE run_history
SET status = ?,
    completed_at = ?,
    records_emitted = ?,
    connector_error_json = ?,
    failure_reason = ?,
    terminal_reason = ?,
    facts_json = ?
WHERE run_id = ?
  AND connector_instance_id = ?
  AND status = 'running'
