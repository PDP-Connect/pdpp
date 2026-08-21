-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: controller_active_runs
-- @max_rows: 128
-- One row per connector with an in-flight controller-managed run; bounded
-- by the count of registered connectors (dozens, not thousands). Used at
-- startup by releaseAbandonedControllerRunClaims, to free claims left
-- behind when the reference server restarted mid-run, and by the
-- browser-surface lease reconciler to decide which leases are still held.
-- Releasing the claim is all this path does; the run's terminal state is
-- adjudicated from the spine by reconcileOrphanedRunsAtBoot.
SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation
FROM controller_active_runs
ORDER BY started_at ASC, connector_id ASC, connector_instance_id ASC
