-- @terminator: exec
-- Legacy store seam retained for generated query-registry compatibility.
-- New device ingest uses the processing reservation methods directly.
INSERT INTO device_ingest_batch_outcomes(
  device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
  connector_id, batch_seq, status, http_status, response_json, record_count,
  durable_prefix_count, created_at, accepted_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
