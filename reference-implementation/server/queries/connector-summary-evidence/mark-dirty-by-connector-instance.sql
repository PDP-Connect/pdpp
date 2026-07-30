-- @terminator: exec
-- Marks one connection's maintained summary evidence dirty, inside the SAME
-- transaction as the canonical mutation that governs it (terminal-gate
-- revision, 2026-07-29 — see deleteConnection's identical existing pattern
-- for connector_summary_evidence deletion). A missing row (0 rows affected)
-- is not an error: the maintenance sweep's rebuild/reconcile pass creates
-- the row on its next observation, same as it always has.
UPDATE connector_summary_evidence
SET dirty = 1,
    state = 'stale',
    last_error = ?
WHERE connector_instance_id = ?;
