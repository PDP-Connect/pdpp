-- @terminator: many
-- @cursor_field: id
-- Load the newest scheduler history rows and return them chronologically
-- so in-memory scheduler projections preserve append order after restart.
SELECT
  id,
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
FROM (
  SELECT *
  FROM scheduler_run_history
  ORDER BY completed_at DESC, id DESC
  LIMIT ?
)
ORDER BY completed_at ASC, id ASC
