-- @terminator: one
SELECT connector_instance_id, active_revision, storage_epoch, updated_at
FROM connector_instance_config_current
WHERE connector_instance_id = ?
LIMIT 1;
