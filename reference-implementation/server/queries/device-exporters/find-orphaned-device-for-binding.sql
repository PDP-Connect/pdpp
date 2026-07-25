-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: device_source_instances
-- @max_rows: 16
-- Design D6 (fix-enroll-stable-binding-identity-key). Finds every device
-- whose identity was durably created for this exact (owner, connector,
-- binding) but which never had ANY enrollment code successfully consumed
-- for it — a partial write orphaned by a failure between identity creation
-- and consume. Excludes revoked devices/source-instances: a deliberately
-- revoked device is not an adoption target. A device with at least one
-- consumed code is a live, already-completed enrollment and is intentionally
-- excluded here (a fresh code for that binding mints a new device, matching
-- the pre-existing "re-enroll forks a fresh device_id, resumes the
-- connector_instance" contract).
--
-- Returns EVERY matching row (no LIMIT) so the caller can fail closed if
-- more than one orphan candidate exists rather than silently picking one —
-- an ambiguous orphan set must never be resolved by guessing. This should
-- be unreachable in practice: resolveOrCreateEnrollmentDevice is the only
-- writer of new devices for a binding and always serializes under a lock
-- (or, on SQLite, the single-writer connection) before creating one, so at
-- most one orphan can ever exist for a given binding at a time.
SELECT dsi.device_id, dsi.source_instance_id
FROM device_source_instances dsi
JOIN device_exporters de ON de.device_id = dsi.device_id
WHERE de.owner_subject_id = ?
  AND dsi.connector_id = ?
  AND dsi.local_binding_id = ?
  AND dsi.status != 'revoked'
  AND de.status != 'revoked'
  AND NOT EXISTS (
    SELECT 1 FROM device_enrollment_codes dec
    WHERE dec.device_id = dsi.device_id AND dec.status = 'consumed'
  )
ORDER BY dsi.created_at DESC
