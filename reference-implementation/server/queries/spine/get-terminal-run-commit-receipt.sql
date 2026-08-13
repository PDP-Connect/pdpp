-- @terminator: one
-- Exact event-id lookup for an already-authorized terminal run commit.
SELECT data_json
FROM spine_events
WHERE event_id = ?
LIMIT 1
