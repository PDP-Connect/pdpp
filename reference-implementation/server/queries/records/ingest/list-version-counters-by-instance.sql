-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: version_counter
-- @max_rows: 4096
-- The reset-safe checkpoint's per-stream component for one connection, read
-- as decimal text (CAST ... AS TEXT) so values beyond 2^53-1 do not lose
-- precision through better-sqlite3's default JS-number binding. Order is
-- irrelevant here — the caller normalizes to UTF-8 byte order. Spec:
-- openspec/changes/reconcile-active-summary-evidence/design.md
SELECT stream, CAST(max_version AS TEXT) AS max_version
FROM version_counter
WHERE connector_instance_id = ?
