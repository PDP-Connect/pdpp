-- @terminator: iterate
-- @cursor_field: marked_at
-- Oldest-first view of currently-dirty scopes for the bounded periodic
-- sweep. The caller breaks after collecting one bounded batch and
-- re-queries this same "front of the queue" view every round -- a cleared
-- scope simply stops appearing.
SELECT connector_instance_id, connector_id, stream, marked_at
FROM search_index_dirty
WHERE dirty <> 0
ORDER BY marked_at ASC, connector_instance_id ASC, stream ASC
