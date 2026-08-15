-- @terminator: iterate
-- @cursor_field: marked_at
-- Oldest-first view of currently-dirty AND currently-eligible scopes for
-- the bounded periodic sweep. Excludes a scope still serving out its
-- post-failure backoff (next_attempt_at in the future) so a permanently-
-- failing scope cannot occupy the front of this ordering forever and
-- starve healthy scopes behind it (failure never advances marked_at).
-- The caller breaks after collecting one bounded batch and re-queries this
-- same "front of the queue" view every round -- a cleared scope simply
-- stops appearing.
SELECT connector_instance_id, connector_id, stream, marked_at, revision
FROM search_index_dirty
WHERE dirty <> 0
  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
ORDER BY marked_at ASC, connector_instance_id ASC, stream ASC
