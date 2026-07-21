-- @terminator: exec
UPDATE device_ingest_batch_outcomes
   SET status = 'accepted',
       accepted_at = ?,
       http_status = ?,
       response_json = ?
 WHERE device_id = ?
   AND batch_id = ?
   AND body_hash = ?
   AND source_instance_id = ?
   AND connector_instance_id = ?
   AND connector_id = ?
   AND batch_seq = ?
   AND manifest_fingerprint = ?
   AND semantic_capability_identity = ?
   AND status = 'processing'
   AND durable_prefix_count = record_count
