-- @terminator: one
-- Presence probe: does this (connector_instance_id, stream) namespace have a
-- version_counter row right now? Read BEFORE a reset's deletes run, in the
-- same transaction, to decide whether the namespace counts toward
-- connector_instances.record_reset_generation. Spec:
-- openspec/changes/reconcile-active-summary-evidence/design.md
SELECT 1 AS present
FROM version_counter
WHERE connector_instance_id = ? AND stream = ?
LIMIT 1
