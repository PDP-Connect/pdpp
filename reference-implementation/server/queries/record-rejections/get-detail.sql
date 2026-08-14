-- @terminator: one
SELECT record_rejections.receipt_id, record_rejections.owner_subject_id,
       record_rejections.connector_instance_id, record_rejections.connector_id,
       record_rejections.stream, record_rejections.run_id,
       record_rejections.first_input_index, record_rejections.latest_input_index,
       record_rejections.first_run_id, record_rejections.latest_run_id,
       record_rejections.reason_code, record_rejections.payload, record_rejections.payload_sha256,
       record_rejections.payload_bytes, record_rejections.replay_count,
       record_rejections.accepted_run_id, record_rejections.accepted_record_key, record_rejections.accepted_at,
       record_rejections.status, record_rejections.created_at, record_rejections.last_seen_at,
       record_rejection_quota.pending_payload_bytes,
       record_rejection_quota.pending_receipt_count,
       (
         SELECT COUNT(*)
         FROM record_rejections connection_record_rejections
         WHERE connection_record_rejections.owner_subject_id = record_rejections.owner_subject_id
           AND connection_record_rejections.connector_instance_id = record_rejections.connector_instance_id
       ) AS connection_receipt_count
FROM record_rejections
JOIN record_rejection_quota ON record_rejection_quota.owner_subject_id = record_rejections.owner_subject_id
WHERE record_rejections.owner_subject_id = ?
  AND record_rejections.connector_instance_id = ?
  AND record_rejections.receipt_id = ?
LIMIT 1
