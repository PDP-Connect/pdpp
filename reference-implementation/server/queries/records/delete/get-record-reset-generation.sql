-- @terminator: one
-- The reset-safe checkpoint's generation component, read as decimal text
-- (CAST ... AS TEXT) so values beyond 2^53-1 do not lose precision through
-- better-sqlite3's default JS-number binding. Spec:
-- openspec/changes/reconcile-active-summary-evidence/design.md
SELECT CAST(record_reset_generation AS TEXT) AS reset_generation
FROM connector_instances
WHERE connector_instance_id = ?
