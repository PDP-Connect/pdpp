-- @terminator: one
-- Returns a run's `run.started` event, or null when the run never
-- reached the runtime's start emit (e.g. a launch failure before spawn).
-- Used by the `GET /_ref/runs/:runId` run-handle status route to report
-- the started timestamp and connector identity without scanning the
-- run's full event list. Bounded by `LIMIT 1`; ordering is on
-- `event_seq` (stable logical sequence), never SQLite `rowid`.
SELECT event_type, status, data_json, occurred_at, trace_id, actor_id
FROM spine_events
WHERE run_id = ?
  AND event_type = 'run.started'
ORDER BY event_seq ASC
LIMIT 1
