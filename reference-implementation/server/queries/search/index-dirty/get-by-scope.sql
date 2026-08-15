-- @terminator: one
-- Read-time self-heal check: is this exact (connector_instance_id, stream)
-- scope currently marked dirty?
SELECT dirty FROM search_index_dirty
WHERE connector_instance_id = ? AND stream = ?
