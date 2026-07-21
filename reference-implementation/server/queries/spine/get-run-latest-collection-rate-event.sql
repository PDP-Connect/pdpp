-- @terminator: one
-- Returns the most recent `run.progress_reported` spine event whose data
-- payload carries a `collection_rate` field for the given run, or null when
-- no such event exists (controller never fired a rate-change transition, or
-- the run predates adaptive rate controller support). Used by the reference
-- control-plane projection to surface `connection_health.collection_rate`
-- for in-progress runs where the terminal event has not yet been written.
-- Bounded by `LIMIT 1`; ordering is on `event_seq` (stable logical sequence).
SELECT data_json
FROM spine_events
WHERE run_id = ?
  AND event_type = 'run.progress_reported'
  AND data_json LIKE '%"collection_rate"%'
ORDER BY event_seq DESC
LIMIT 1
