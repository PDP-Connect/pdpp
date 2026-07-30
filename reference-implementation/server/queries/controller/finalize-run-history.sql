-- @terminator: exec
-- Finalize the run-grain row at the terminal spine event
-- (run.completed/run.failed/run.cancelled). Only transitions a row still
-- in `running` state, so a retried/duplicate terminal emission for the
-- same run_id is a no-op (idempotent finalize). If no started row exists
-- (the `run.started` write raced or was lost), this UPDATE affects zero
-- rows; the caller falls back to insert-finalized directly. See
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
  AND status = 'running'
