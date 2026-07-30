-- @terminator: one
-- Read the newest terminal/skip run-history record for one configured
-- connection. This is the LIST last-run-facts fallback
-- (getLatestRunSummaryForConnection, ref-control.ts) and must produce
-- byte-identical output to before the generalized run-grain writer
-- landed (Slice A explicitly does not touch LIST output) — scoped to
-- `scheduler_managed` rows so a manual/browser/cancelled run's new
-- run_history row (written by server/stores/run-history-writer.ts) does
-- not newly surface here. Widening this fallback to every run kind is a
-- deliberate follow-up slice, not an incidental side effect of this one.
-- `status <> 'running'` excludes the started-but-not-yet-finalized rows
-- the generalized writer creates (openspec/changes/
-- generalize-run-history-write-authority).
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
FROM run_history
WHERE connector_instance_id = ?
  AND status <> 'running'
  AND scheduler_managed
  AND (? IS NULL OR status = ?)
ORDER BY completed_at DESC, id DESC
LIMIT 1
