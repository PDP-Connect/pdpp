-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: connector_instances
-- @max_rows: 1024
-- Every instance's own `record_identity_generation` checkpoint for a
-- connector type, so a generic (connector-agnostic) reconcile pass can
-- diff each instance's last-reconciled generation against the shipped
-- manifest's declared generation and invalidate ONLY the instances still
-- behind -- never the whole connector type. See
-- `ensureRecordIdentityGenerationColumn` in db.ts for the column's design.
SELECT connector_instance_id, record_identity_generation
FROM connector_instances
WHERE connector_id = ?
ORDER BY connector_instance_id ASC
