-- @terminator: exec
-- Set one instance's `record_identity_generation` checkpoint to the exact
-- shipped-manifest-declared generation it was just reconciled against.
-- Set (not incremented) because the source of truth is the manifest's own
-- declared integer, not a local counter -- an instance that was two
-- generations behind converges to the current value in one write.
UPDATE connector_instances
   SET record_identity_generation = ?
 WHERE connector_instance_id = ?
