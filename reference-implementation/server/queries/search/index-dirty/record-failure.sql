-- @terminator: exec_one
-- Structured failure evidence (I6): a reconcile attempt for this scope
-- failed. dirty stays 1 (unchanged) so the next sweep/read-trigger retries;
-- last_error is observable evidence, not just a console.warn line. attempts
-- increments so the caller can compute this scope's next backoff delay
-- (see search-index-dirty-store.ts's backoffDelayMsForAttempt) --
-- starvation-avoidance: a scope that fails every reconcile attempt must
-- not occupy the front of the oldest-first queue forever.
UPDATE search_index_dirty
SET last_error = ?, attempts = attempts + 1
WHERE connector_instance_id = ? AND stream = ?
RETURNING attempts
