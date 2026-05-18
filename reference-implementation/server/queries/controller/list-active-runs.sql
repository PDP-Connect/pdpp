-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: controller_active_runs
-- @max_rows: 128
-- One row per connector with an in-flight controller-managed run; bounded
-- by the count of registered connectors (dozens, not thousands). Used by
-- reconcileAbandonedControllerRuns at startup to enumerate stale rows
-- left behind when the reference server restarted mid-run.
SELECT connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at
FROM controller_active_runs
ORDER BY started_at ASC, connector_id ASC, connector_instance_id ASC
