-- @terminator: exec
-- Starvation-avoidance backoff (I5/review): schedules this scope's next
-- eligible reconcile attempt after a failure, so a permanently-failing
-- scope stops occupying the front of the oldest-first dirty-scope queue
-- and a later healthy scope can take its page slot.
UPDATE search_index_dirty
SET next_attempt_at = ?
WHERE connector_instance_id = ? AND stream = ?
