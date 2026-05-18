-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: records
-- @max_rows: 1024
-- Distinct instance namespaces with at least one row (live or soft-deleted)
-- for a connector type. Used by `deleteAllRecordsForConnector` so manifest
-- fingerprint cleanup removes per-instance storage without using connector_id
-- as the durable instance key.
SELECT connector_instance_id, stream
FROM records
WHERE connector_id = ?
GROUP BY connector_instance_id, stream
ORDER BY connector_instance_id ASC, stream ASC
