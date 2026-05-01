-- @terminator: many
-- @cursor_field: created_at
SELECT rowid, device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at
FROM device_ingest_batch_outcomes
WHERE (? IS NULL OR device_id = ?)
ORDER BY created_at DESC, rowid DESC
LIMIT ?
