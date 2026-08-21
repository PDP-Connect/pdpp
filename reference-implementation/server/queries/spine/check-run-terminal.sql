-- @terminator: one
-- True/false probe for whether a run already has a terminal event
-- (run.completed | run.failed | run.browser_surface_failed |
-- run.cancelled | run.abandoned) on the
-- spine. Used by the controller's run-completion paths before writing a
-- terminal event, so a run that already reached a terminal state just
-- before the in-memory cleanup missed it is not terminalised twice.
--
-- Startup adjudication of runs whose owner epoch is gone lives in
-- lib/controller-boot.ts (reconcileOrphanedRunsAtBoot), which reads the
-- spine directly rather than probing per run.
SELECT 1 AS present
FROM spine_events
WHERE run_id = ?
  AND event_type IN ('run.completed', 'run.failed', 'run.browser_surface_failed', 'run.cancelled', 'run.abandoned')
LIMIT 1
