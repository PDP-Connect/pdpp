-- @terminator: exec
-- Create the run-grain row for a run at `run.started`. Idempotent under
-- retried/duplicate `run.started` emissions for the same run_id: the
-- unique index on run_id makes a second insert a no-op rather than a
-- duplicate row or an error. See openspec/changes/
-- generalize-run-history-write-authority.
INSERT INTO run_history(
  run_id,
  connector_instance_id,
  connector_id,
  trigger_kind,
  source_json,
  status,
  known_gaps_json,
  started_at,
  attempt
) VALUES(?, ?, ?, ?, ?, 'running', '[]', ?, 1)
ON CONFLICT(run_id) WHERE run_id IS NOT NULL DO NOTHING
