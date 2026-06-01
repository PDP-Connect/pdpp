-- @terminator: exec
-- Clear the device source-instance back-reference to one deleted connection.
-- Sets connector_instance_id = NULL on every device_source_instances row that
-- points at the given connector_instance_id, WITHOUT deleting the device edge
-- itself (that is device de-enrollment, a different action). The device row and
-- its sibling connections stay intact. Used by the connection-delete cascade so
-- a deleted connection leaves no dangling back-reference. Spec:
-- add-owner-connection-delete-contract (device-source-instance row of the
-- cascade table; "Two connections share one device" scenario).
UPDATE device_source_instances
SET connector_instance_id = NULL, updated_at = ?
WHERE connector_instance_id = ?
