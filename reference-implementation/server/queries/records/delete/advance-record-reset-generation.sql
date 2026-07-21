-- @terminator: exec
-- Advance one connection's reset-safe checkpoint generation by the exact
-- count of distinct stream namespaces the in-flight reset touched that held
-- a version_counter row or a live canonical record. Runs in the SAME
-- transaction as the reset's deletes. A count of 0 is a checkpoint no-op
-- (the caller skips this statement entirely in that case). Spec:
-- openspec/changes/reconcile-active-summary-evidence/design.md
UPDATE connector_instances
   SET record_reset_generation = record_reset_generation + ?
 WHERE connector_instance_id = ?
