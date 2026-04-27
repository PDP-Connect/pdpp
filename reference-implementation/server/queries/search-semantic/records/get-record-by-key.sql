-- @terminator: one
SELECT emitted_at, record_json FROM records
WHERE connector_id = ? AND stream = ? AND record_key = ? AND deleted = 0
