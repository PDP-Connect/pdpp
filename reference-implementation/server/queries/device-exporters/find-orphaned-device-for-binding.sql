-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: device_source_instances
-- @max_rows: 16
-- Design D6 (fix-enroll-stable-binding-identity-key), qualified by
-- source_kind per the D7 correction (fix-enroll-source-kind-identity-gap).
-- Finds every device whose identity was durably created for this exact
-- (owner, connector, source_kind, binding) but which never had ANY
-- enrollment code successfully consumed for it — a partial write orphaned
-- by a failure between identity creation and consume. Excludes revoked
-- devices/source-instances: a deliberately revoked device is not an
-- adoption target. A device with at least one consumed code is a live,
-- already-completed enrollment and is intentionally excluded here (a fresh
-- code for that binding mints a new device, matching the pre-existing
-- "re-enroll forks a fresh device_id, resumes the connector_instance"
-- contract).
--
-- source_kind is matched exactly (never NULL-permissive): the same owner,
-- connector, and binding name can be enrolled under two structurally
-- distinct connector-instance kinds (e.g. local_device vs
-- browser_collector), and an orphan from one kind must never be adopted by
-- an enrollment resolving to the other. A NULL source_kind row (written
-- before this column existed) matches no candidate and is therefore never
-- adopted, which is safe: it simply falls through to minting a fresh
-- device, never a cross-kind collision.
--
-- Returns EVERY matching row (no LIMIT) so the caller can fail closed if
-- more than one orphan candidate exists rather than silently picking one —
-- an ambiguous orphan set must never be resolved by guessing. This should
-- be unreachable in practice: resolveOrCreateEnrollmentDevice is the only
-- writer of new devices for a binding and always serializes under a lock
-- (or, on SQLite, the single-writer connection) before creating one, so at
-- most one orphan can ever exist for a given (owner, connector, source_kind,
-- binding) at a time.
SELECT dsi.device_id, dsi.source_instance_id
FROM device_source_instances dsi
JOIN device_exporters de ON de.device_id = dsi.device_id
WHERE de.owner_subject_id = ?
  AND dsi.connector_id = ?
  AND dsi.source_kind = ?
  AND dsi.local_binding_id = ?
  AND dsi.status != 'revoked'
  AND de.status != 'revoked'
  AND NOT EXISTS (
    SELECT 1 FROM device_enrollment_codes dec
    WHERE dec.device_id = dsi.device_id AND dec.status = 'consumed'
  )
ORDER BY dsi.created_at DESC
