-- @terminator: one
SELECT device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at
FROM device_ingest_batch_outcomes
WHERE device_id = ?
  AND batch_id = ?
