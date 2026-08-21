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
-- Terminal-outcome columns are fenced on `status = 'running'`. The
-- enrichment columns are not. This was the ONLY status writer without a
-- fence, and the header above explains why that mattered: the general
-- writer normally finalizes this row FIRST, so an unfenced
-- `status = excluded.status` let a scheduler retry revise an
-- already-terminal outcome (forbidden transitions F5 and F7, both violated
-- by one statement).
--
-- The fence is per-column rather than a `WHERE` on DO UPDATE because this
-- upsert has two jobs: recording an outcome AND merging scheduler-only
-- enrichment (attempt, checkpoint_summary_json, known_gaps_json,
-- reported_records_emitted). A statement-level WHERE would drop the
-- enrichment along with the status revision, which is a behavior change.
-- Keeping enrichment unfenced preserves it, and fencing the outcome
-- columns makes terminal mean terminal.
ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO UPDATE SET
  source_json = excluded.source_json,
  status = CASE WHEN run_history.status = 'running' THEN excluded.status ELSE run_history.status END,
  records_emitted = CASE
    WHEN run_history.status = 'running' THEN excluded.records_emitted
    ELSE run_history.records_emitted
  END,
  reported_records_emitted = excluded.reported_records_emitted,
  checkpoint_summary_json = excluded.checkpoint_summary_json,
  known_gaps_json = excluded.known_gaps_json,
  connector_error_json = excluded.connector_error_json,
  trace_id = excluded.trace_id,
  failure_reason = CASE
    WHEN run_history.status = 'running' THEN excluded.failure_reason
    ELSE run_history.failure_reason
  END,
  terminal_reason = CASE
    WHEN run_history.status = 'running' THEN excluded.terminal_reason
    ELSE run_history.terminal_reason
  END,
  completed_at = CASE
    WHEN run_history.status = 'running' THEN excluded.completed_at
    ELSE run_history.completed_at
  END,
  error = CASE WHEN run_history.status = 'running' THEN excluded.error ELSE run_history.error END,
  attempt = excluded.attempt,
  scheduler_managed = 1
