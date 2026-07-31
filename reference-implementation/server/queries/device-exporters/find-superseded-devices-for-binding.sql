-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: device_source_instances
-- @max_rows: 16
-- Finds every OTHER active device durably bound to this exact (owner,
-- connector, source_kind, binding) whose enrollment already completed (at
-- least one consumed code) — the complement of
-- find-orphaned-device-for-binding.sql, which finds a partial-write orphan
-- that never completed. A genuinely new enrollment for an already-completed
-- binding intentionally mints a fresh device (resolveOrCreateEnrollmentDevice
-- never adopts a completed device), so every row this query returns is a
-- PRIOR device that the fresh device now supersedes for the same binding —
-- stale evidence a live collector will never heartbeat again. The caller
-- revokes each via the existing revokeDevice cascade (never a raw status
-- flip), which safely spares the connector_instance because the fresh
-- device's own non-revoked source-instance still references it.
--
-- Excludes device_id = ? (the fresh device just resolved) so a caller that
-- runs this AFTER upsertSourceInstance never revokes the device it just
-- created for this same enrollment.
SELECT dsi.device_id, dsi.source_instance_id
FROM device_source_instances dsi
JOIN device_exporters de ON de.device_id = dsi.device_id
WHERE de.owner_subject_id = ?
  AND dsi.connector_id = ?
  AND dsi.source_kind = ?
  AND dsi.local_binding_id = ?
  AND dsi.device_id != ?
  AND dsi.status != 'revoked'
  AND de.status != 'revoked'
  AND EXISTS (
    SELECT 1 FROM device_enrollment_codes dec
    WHERE dec.device_id = dsi.device_id AND dec.status = 'consumed'
  )
ORDER BY dsi.created_at DESC
