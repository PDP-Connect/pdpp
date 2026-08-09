-- @terminator: exec
-- Clear one scope's dirty flag after a reconcile pass proves its
-- lexical+semantic index is in sync. Idempotent. Resets attempts/
-- next_attempt_at too, so a scope that recovers does not carry stale
-- backoff state into its next dirty cycle (a fresh re-dirty should retry
-- immediately, not inherit a prior failure streak's delay).
UPDATE search_index_dirty
SET dirty = 0, reconciled_at = ?, last_error = NULL, attempts = 0, next_attempt_at = NULL
WHERE connector_instance_id = ? AND stream = ?
