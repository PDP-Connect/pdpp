-- @terminator: one
-- Presence probe: does this (connector_instance_id, stream) namespace have at
-- least one live (non-deleted) canonical record right now? Read BEFORE a
-- reset's deletes run, in the same transaction, to decide whether the
-- namespace counts toward connector_instances.record_reset_generation — the
-- union rule covers recoverable counter drift (a live record whose counter
-- row is already missing still counts). Spec:
-- openspec/changes/reconcile-active-summary-evidence/design.md
SELECT 1 AS present
FROM records
WHERE connector_instance_id = ? AND stream = ? AND deleted = 0
LIMIT 1
