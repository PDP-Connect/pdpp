-- @terminator: exec
-- Design D8 (fix-enroll-connector-instance-pk-collision). Migrates a
-- pre-existing connector_instances row, PROVEN by the caller to be the same
-- logical binding under a legacy source_binding_key derivation (see
-- isSameLogicalBindingUnderLegacyKey in connector-instance-store.js), to the
-- current stable {kind, local_binding_name} key shape -- in place, keeping
-- the same connector_instance_id and every reference to it.
UPDATE connector_instances
SET display_name = ?,
    status = ?,
    source_binding_key = ?,
    source_binding_json = ?,
    updated_at = ?,
    revoked_at = ?
WHERE connector_instance_id = ?;
