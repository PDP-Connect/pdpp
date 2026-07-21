-- @terminator: one
-- Exact run-correlation probe for disclosure-spine search.
SELECT 1 AS present
FROM spine_events
WHERE run_id = ?
LIMIT 1
