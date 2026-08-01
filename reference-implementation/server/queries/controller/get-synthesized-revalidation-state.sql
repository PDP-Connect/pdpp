-- @terminator: one
-- Read the durable per-connection cadence anchor for bounded synthesized
-- owner-action revalidation (see runtime/scheduler/synthesized-attention-
-- revalidation.ts). One row per connector instance, independent of
-- run_history retention/eviction.
SELECT connector_instance_id, connector_id, attempt, anchor_at, updated_at
FROM synthesized_revalidation_state
WHERE connector_instance_id = ?
