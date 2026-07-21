-- @terminator: exec
-- Persist one scheduler terminal/skip record for operator history.
-- Payload-shaped fields stay JSON so the store surface can remain semantic
-- and avoid leaking table columns to the runtime scheduler.
INSERT INTO scheduler_run_history(
  connector_instance_id,
  connector_id,
  source_json,
  status,
  records_emitted,
  reported_records_emitted,
  checkpoint_summary_json,
  known_gaps_json,
  connector_error_json,
  run_id,
  trace_id,
  failure_reason,
  terminal_reason,
  started_at,
  completed_at,
  error,
  attempt
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
