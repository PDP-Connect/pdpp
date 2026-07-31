-- @terminator: exec
-- Create the run-grain row for a run at `run.started`. Idempotent under
-- retried/duplicate `run.started` emissions for the same (run_id,
-- connector_instance_id): the unique index on that pair makes a second
-- insert a no-op rather than a duplicate row or an error.
-- run_id alone is NOT globally unique — two different connections can
-- independently mint the same run_id (both derive from Date.now()-based
-- generators with no connection-scoped entropy); (run_id,
-- connector_instance_id) is the real identity. See openspec/changes/
-- generalize-run-history-write-authority and
-- openspec/changes/run-history-backfill-list-cutover (duplicate-safe
-- identity fix).
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
ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO NOTHING
