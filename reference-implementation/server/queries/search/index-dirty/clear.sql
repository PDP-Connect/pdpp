-- @terminator: exec
-- Clear one scope's dirty flag after a reconcile pass proves its
-- lexical+semantic index is in sync. Idempotent. Resets attempts/
-- next_attempt_at too, so a scope that recovers does not carry stale
-- backoff state into its next dirty cycle (a fresh re-dirty should retry
-- immediately, not inherit a prior failure streak's delay).
--
-- CAS on revision, NOT marked_at: a reconcile pass proves the scope was in
-- sync as of WHEN IT STARTED SCANNING, not as of now. A concurrent write
-- landing during the scan re-marks dirty=1 and bumps revision
-- (mark-dirty.sql). marked_at alone cannot detect this reliably -- two
-- durable marks within the same millisecond can receive an IDENTICAL ISO
-- marked_at string, so a marked_at-only CAS could pass even though a mark
-- landed after the reconcile's read, silently discarding it. revision is
-- atomically incremented exactly once per mark and can never collide this
-- way. Requiring revision to still equal the value read at scan-start
-- makes the clear a no-op whenever a write raced past it -- the scope
-- stays dirty for the next round instead.
UPDATE search_index_dirty
SET dirty = 0, reconciled_at = ?, last_error = NULL, attempts = 0, next_attempt_at = NULL
WHERE connector_instance_id = ? AND stream = ? AND revision = ?
