-- @terminator: one
SELECT device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
       connector_id, batch_seq, status, http_status, response_json,
       record_count, durable_prefix_count, manifest_fingerprint,
       semantic_capability_identity, created_at, accepted_at
FROM device_ingest_batch_outcomes
WHERE device_id = ?
  AND batch_id = ?
