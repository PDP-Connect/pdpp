-- @terminator: one
SELECT receipt_id, owner_subject_id, connector_instance_id, connector_id, stream, run_id,
       first_input_index, latest_input_index, reason_code, payload_text, payload_sha256,
       payload_bytes, replay_count, status, created_at, last_seen_at
FROM record_rejections
WHERE owner_subject_id = ?
  AND connector_instance_id = ?
  AND receipt_id = ?
LIMIT 1
