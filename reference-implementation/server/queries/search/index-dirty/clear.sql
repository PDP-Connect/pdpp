-- @terminator: exec
-- Clear one scope's dirty flag after a reconcile pass proves its
-- lexical+semantic index is in sync. Idempotent.
UPDATE search_index_dirty
SET dirty = 0, reconciled_at = ?, last_error = NULL
WHERE connector_instance_id = ? AND stream = ?
