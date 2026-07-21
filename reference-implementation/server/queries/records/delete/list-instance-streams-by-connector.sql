-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: records
-- @max_rows: 1024
-- Distinct instance namespaces for a connector type, from the UNION of
-- `records` (at least one row, live or soft-deleted) and `version_counter`
-- (a stream whose live records were already fully deleted but whose reset
-- checkpoint has not converged yet still needs its counter cleared — see
-- design.md "Exact reset-safe record checkpoint": the union rule that
-- already governs `advanceSqliteRecordResetGenerationForStreams` is only
-- correct if THIS discovery query surfaces every such pair in the first
-- place; a version_counter-only pair invisible here is silently skipped by
-- connector-wide invalidation, Sol P2.2). Used by
-- `deleteAllRecordsForConnector` so manifest fingerprint cleanup removes
-- per-instance storage without using connector_id as the durable instance
-- key.
SELECT connector_instance_id, stream
FROM (
  SELECT connector_instance_id, stream FROM records WHERE connector_id = ?
  UNION
  SELECT connector_instance_id, stream FROM version_counter WHERE connector_id = ?
) AS namespaces
GROUP BY connector_instance_id, stream
ORDER BY connector_instance_id ASC, stream ASC
