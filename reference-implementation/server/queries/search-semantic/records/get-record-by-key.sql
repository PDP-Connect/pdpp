-- @terminator: one
SELECT emitted_at, record_json FROM records
WHERE connector_instance_id = ? AND stream = ? AND record_key = ? AND deleted = 0
