-- @terminator: one
-- Read a single non-deleted record by primary key for /v1/records/{id}
-- handling. The caller layers grant-side resource and time-range checks
-- on top before responding. `record_json_bytes` is the same
-- LENGTH(CAST(... AS BLOB)) expression the retained-size top-N rebuild
-- already uses (retained-size-read-model.ts) — bare LENGTH() would
-- undercount non-ASCII text, so this must stay CAST(... AS BLOB).
SELECT record_key, record_json, emitted_at, LENGTH(CAST(record_json AS BLOB)) AS record_json_bytes
FROM records
WHERE connector_instance_id = ?
  AND stream = ?
  AND record_key = ?
  AND deleted = 0
