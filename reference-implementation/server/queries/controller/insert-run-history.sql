-- @terminator: exec
-- Persist one scheduler terminal/skip record for operator history.
-- `runtime/index.ts`'s general executor (called by the scheduler's own
-- run-executor as `runConnector`) already writes/finalizes this exact
-- (run_id, connector_instance_id) row via the run.started/terminal
-- spine-event hook (server/stores/run-history-writer.ts) before this call
-- runs, so this is normally an UPDATE-by-conflict that fills in the
-- scheduler-only enrichment fields (attempt, checkpoint_summary_json,
-- known_gaps_json, reported_records_emitted) the general writer does not
-- carry — see openspec/changes/generalize-run-history-write-authority.
-- Conflict target is (run_id, connector_instance_id), not run_id alone —
-- run_id is NOT globally unique across connections (see
-- openspec/changes/run-history-backfill-list-cutover). The plain INSERT
-- branch (ON CONFLICT DO UPDATE) also covers the case where no row
-- exists yet (e.g. a scheduler_run_history row inserted before the
-- generalized writer existed, or a test/fixture path that only calls this
-- store method directly). Payload-shaped fields stay JSON so the store
-- surface can remain semantic and avoid leaking table columns to the
-- runtime scheduler.
INSERT INTO run_history(
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
  attempt,
  scheduler_managed
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO UPDATE SET
  source_json = excluded.source_json,
  status = excluded.status,
  records_emitted = excluded.records_emitted,
  reported_records_emitted = excluded.reported_records_emitted,
  checkpoint_summary_json = excluded.checkpoint_summary_json,
  known_gaps_json = excluded.known_gaps_json,
  connector_error_json = excluded.connector_error_json,
  trace_id = excluded.trace_id,
  failure_reason = excluded.failure_reason,
  terminal_reason = excluded.terminal_reason,
  completed_at = excluded.completed_at,
  error = excluded.error,
  attempt = excluded.attempt,
  scheduler_managed = 1
