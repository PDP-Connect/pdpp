-- @terminator: one
-- Exact trace-correlation probe for disclosure-spine search.
SELECT 1 AS present
FROM spine_events
WHERE trace_id = ?
LIMIT 1
