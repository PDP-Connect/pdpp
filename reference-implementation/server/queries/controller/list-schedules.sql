-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: connector_schedules
-- @max_rows: 128
-- Whole-table scan of the schedule registry; bounded by the count of
-- registered connectors. Each row gets joined to in-memory runtime
-- projections downstream so callers cannot stream this — the page is
-- materialized in full.
SELECT connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
FROM connector_schedules
ORDER BY connector_id ASC
