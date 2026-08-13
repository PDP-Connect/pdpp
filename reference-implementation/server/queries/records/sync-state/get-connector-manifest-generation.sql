-- @terminator: one
SELECT manifest_generation
FROM connector_instances
WHERE connector_instance_id = ?
LIMIT 1;
