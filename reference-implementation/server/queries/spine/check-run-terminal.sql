-- @terminator: one
-- True/false probe for whether a run already has a terminal event
-- (run.completed | run.failed | run.cancelled | run.abandoned) on the
-- spine. Used by reconcileAbandonedControllerRuns at startup before
-- emitting a restart-driven `run.failed` so we don't duplicate a
-- terminal that was emitted just before the crash but missed the
-- in-memory cleanup.
SELECT 1 AS present
FROM spine_events
WHERE run_id = ?
  AND event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')
LIMIT 1
