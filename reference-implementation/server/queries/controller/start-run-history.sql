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
--
-- `owner_epoch` is the fence every run-state transition compares against
-- (runtime/run-lifecycle.ts). It is stamped HERE, at run creation, from the
-- emitting process's `data.boot_epoch` — the same value lib/spine.ts's
-- assertRunStartedIsStamped already requires on every run.started, so the
-- writer persists a guaranteed value rather than a best-effort one.
-- Claiming the row at creation is what lets successor adjudication tell live
-- work from an orphan: with the column NULL, the adjudication predicate's
-- `owner_epoch IS NULL` arm matches every row, including runs a live process
-- started seconds ago.
INSERT INTO run_history(
  run_id,
  connector_instance_id,
  connector_id,
  trigger_kind,
  source_json,
  status,
  known_gaps_json,
  started_at,
  attempt,
  owner_epoch
) VALUES(?, ?, ?, ?, ?, 'running', '[]', ?, 1, ?)
ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO NOTHING
