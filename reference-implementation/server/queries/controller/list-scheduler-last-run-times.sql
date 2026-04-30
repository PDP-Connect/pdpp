-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: scheduler_last_run_times
-- @max_rows: 128
-- One row per scheduled connector; bounded by connector count.
SELECT connector_id, last_run_time_ms, updated_at
FROM scheduler_last_run_times
ORDER BY connector_id ASC
