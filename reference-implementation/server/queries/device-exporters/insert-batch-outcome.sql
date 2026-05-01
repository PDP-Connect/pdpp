-- @terminator: exec
INSERT INTO device_ingest_batch_outcomes(
  device_id, batch_id, body_hash, source_instance_id, status, http_status, response_json, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
