-- @terminator: many
-- @cursor_field: created_at
SELECT rowid, device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
       connector_id, batch_seq, status, http_status, response_json, record_count,
       durable_prefix_count, manifest_fingerprint, semantic_capability_identity,
       created_at, accepted_at
FROM device_ingest_batch_outcomes
WHERE (? IS NULL OR device_id = ?)
ORDER BY created_at DESC, rowid DESC
LIMIT ?
