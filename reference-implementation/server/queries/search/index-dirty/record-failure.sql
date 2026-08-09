-- @terminator: exec
-- Structured failure evidence (I6): a reconcile attempt for this scope
-- failed. dirty stays 1 (unchanged) so the next sweep/read-trigger retries;
-- last_error is observable evidence, not just a console.warn line.
UPDATE search_index_dirty
SET last_error = ?
WHERE connector_instance_id = ? AND stream = ?
