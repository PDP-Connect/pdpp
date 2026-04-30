-- @terminator: one
-- Exact grant-correlation probe for disclosure-spine search.
SELECT 1 AS present
FROM spine_events
WHERE grant_id = ?
LIMIT 1
