-- @terminator: one
-- Read the newest scheduler terminal/skip record for one configured connection.
SELECT
  id,
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
FROM scheduler_run_history
WHERE connector_instance_id = ?
  AND (? IS NULL OR status = ?)
ORDER BY completed_at DESC, id DESC
LIMIT 1
