-- @terminator: exec
UPDATE device_ingest_batch_outcomes
   SET manifest_fingerprint = ?,
       semantic_capability_identity = ?
 WHERE device_id = ?
   AND batch_id = ?
   AND body_hash = ?
   AND source_instance_id = ?
   AND connector_instance_id = ?
   AND connector_id = ?
   AND batch_seq = ?
   AND status = 'processing'
