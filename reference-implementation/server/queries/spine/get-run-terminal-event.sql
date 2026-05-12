-- @terminator: one
-- Returns the most recent terminal event for a run, or null if the run
-- is still in progress. "Terminal" = run.completed | run.failed |
-- run.cancelled | run.abandoned. Used by ref-control's run-summary
-- helper to extract `known_gaps` and `failure_reason` without scanning
-- the run's full event list. Ordering is on `event_seq` (stable logical
-- sequence) so this query no longer leaks SQLite `rowid`.
SELECT event_type, status, data_json, occurred_at
FROM spine_events
WHERE run_id = ?
  AND event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')
ORDER BY event_seq DESC
LIMIT 1
