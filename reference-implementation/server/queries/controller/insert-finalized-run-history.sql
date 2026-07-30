-- @terminator: exec
-- Fallback path when a terminal spine event's `finalize` UPDATE affected
-- zero rows — no `running` row existed for this run_id (the `run.started`
-- write raced, was lost, or predates this writer). Inserts the run
-- already in its terminal state. ON CONFLICT DO NOTHING keeps this
-- idempotent if the finalize path is retried concurrently. See
-- openspec/changes/generalize-run-history-write-authority.
INSERT INTO run_history(
  run_id,
  connector_instance_id,
  connector_id,
  trigger_kind,
  source_json,
  status,
  known_gaps_json,
  started_at,
  completed_at,
  records_emitted,
  connector_error_json,
  failure_reason,
  terminal_reason,
  facts_json,
  attempt
) VALUES(?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, 1)
ON CONFLICT(run_id) WHERE run_id IS NOT NULL DO NOTHING
