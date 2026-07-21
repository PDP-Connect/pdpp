-- @terminator: exec
INSERT INTO device_ingest_batch_outcomes(
  device_id, batch_id, body_hash, source_instance_id, connector_instance_id,
  connector_id, batch_seq, status, record_count, durable_prefix_count,
  manifest_fingerprint, semantic_capability_identity, created_at
) VALUES(?, ?, ?, ?, ?, ?, ?, 'processing', ?, 0, ?, ?, ?)
