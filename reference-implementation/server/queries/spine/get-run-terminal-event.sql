-- @terminator: one
-- Returns the most recent terminal event for a run, or null if the run
-- is still in progress. "Terminal" = run.completed | run.failed |
-- run.cancelled. Used by ref-control's run-summary helper to extract
-- `known_gaps` and `failure_reason` without scanning the run's full
-- event list.
SELECT event_type, status, data_json, occurred_at
FROM spine_events
WHERE run_id = ?
  AND (event_type = 'run.completed'
       OR event_type = 'run.failed'
       OR event_type = 'run.cancelled')
ORDER BY rowid DESC
LIMIT 1
