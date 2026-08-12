-- @terminator: exec
-- Clear one scope's dirty flag after a reconcile pass proves its
-- lexical+semantic index is in sync. Idempotent. Resets attempts/
-- next_attempt_at too, so a scope that recovers does not carry stale
-- backoff state into its next dirty cycle (a fresh re-dirty should retry
-- immediately, not inherit a prior failure streak's delay).
--
-- CAS on marked_at: a reconcile pass proves the scope was in sync as of
-- WHEN IT STARTED SCANNING, not as of now. A concurrent write landing
-- during the scan re-marks dirty=1 with a NEW marked_at (mark-dirty.sql);
-- if the clear below were unconditional it would silently discard that
-- fresh dirty mark, permanently losing the scope's re-check. Requiring
-- marked_at to still equal the value read at scan-start makes the clear a
-- no-op whenever a write raced past it -- the scope stays dirty for the
-- next round instead.
UPDATE search_index_dirty
SET dirty = 0, reconciled_at = ?, last_error = NULL, attempts = 0, next_attempt_at = NULL
WHERE connector_instance_id = ? AND stream = ? AND marked_at = ?
