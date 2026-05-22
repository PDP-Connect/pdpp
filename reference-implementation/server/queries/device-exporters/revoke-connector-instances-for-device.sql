-- @terminator: exec
-- Revoke connector_instances referenced by this device's source instances
-- ONLY when no remaining non-revoked device_source_instances reference them.
-- This preserves connector_instances that are shared across devices (e.g. a
-- stable binding re-enrolled under a new device), which the stable-binding
-- lane relies on.
--
-- Run AFTER the device's own device_source_instances have been marked
-- revoked, so the NOT EXISTS check sees only other devices' active bindings.
UPDATE connector_instances
SET status = 'revoked', revoked_at = ?, updated_at = ?
WHERE status <> 'revoked'
  AND connector_instance_id IN (
    SELECT connector_instance_id
    FROM device_source_instances
    WHERE device_id = ?
      AND connector_instance_id IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM device_source_instances active
    WHERE active.connector_instance_id = connector_instances.connector_instance_id
      AND active.status <> 'revoked'
  )
