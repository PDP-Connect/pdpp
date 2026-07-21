-- @terminator: exec
UPDATE device_ingest_batch_outcomes
   SET durable_prefix_count = durable_prefix_count + 1
 WHERE device_id = ?
   AND batch_id = ?
   AND body_hash = ?
   AND source_instance_id = ?
   AND connector_instance_id = ?
   AND connector_id = ?
   AND batch_seq = ?
   AND status = 'processing'
   AND durable_prefix_count = ?
