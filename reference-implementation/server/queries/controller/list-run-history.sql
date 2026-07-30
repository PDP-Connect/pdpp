-- @terminator: many
-- @cursor_field: id
-- Load the newest terminal run-history rows and return them chronologically
-- so in-memory scheduler projections preserve append order after restart.
-- Every caller of this method (scheduler.ts hydratePersistence,
-- controller.ts getLastRunTimeMs/loadScheduleHistoryIndex) is scheduler-era
-- cadence/backoff/dashboard machinery, so this reader is scoped to
-- `scheduler_managed` rows only. `status <> 'running'` excludes the
-- started-but-not-yet-finalized rows the generalized run-grain writer now
-- creates (openspec/changes/generalize-run-history-write-authority) —
-- this reader must keep seeing only terminal/skip rows, unchanged.
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
FROM (
  SELECT *
  FROM run_history
  WHERE status <> 'running'
    AND scheduler_managed
  ORDER BY completed_at DESC, id DESC
  LIMIT ?
)
ORDER BY completed_at ASC, id ASC
