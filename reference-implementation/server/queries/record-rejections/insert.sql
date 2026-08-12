-- @terminator: exec
INSERT INTO record_rejections(
  receipt_id, owner_subject_id, connector_instance_id, connector_id, stream, run_id,
  first_input_index, latest_input_index, first_run_id, latest_run_id, reason_code, payload, payload_sha256,
  payload_bytes, rejection_generation, replay_key, replay_count, status, created_at, last_seen_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)
