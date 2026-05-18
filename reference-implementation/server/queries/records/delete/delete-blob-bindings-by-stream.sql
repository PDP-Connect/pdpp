-- @terminator: exec
DELETE FROM blob_bindings
WHERE connector_instance_id = ? AND stream = ?
