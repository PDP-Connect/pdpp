-- @terminator: exec
-- Persist the in-flight run for a connector. ON CONFLICT(connector_id)
-- DO UPDATE keeps the table at most one row per connector — manual
-- runNow already guards against concurrent active runs in memory, but
-- the upsert is the durable enforcement point if a process restarts
-- while a stale row remains.
INSERT INTO controller_active_runs(connector_id, run_id, trace_id, scenario_id, started_at)
VALUES(?, ?, ?, ?, ?)
ON CONFLICT(connector_id) DO UPDATE SET
  run_id = excluded.run_id,
  trace_id = excluded.trace_id,
  scenario_id = excluded.scenario_id,
  started_at = excluded.started_at
