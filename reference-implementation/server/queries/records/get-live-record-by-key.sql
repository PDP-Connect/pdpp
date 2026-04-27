-- @terminator: one
-- Read a single non-deleted record by primary key for /v1/records/{id}
-- handling. The caller layers grant-side resource and time-range checks
-- on top before responding.
SELECT record_key, record_json, emitted_at
FROM records
WHERE connector_id = ?
  AND stream = ?
  AND record_key = ?
  AND deleted = 0
