-- @terminator: many
-- @cursor_field: created_at
SELECT record_rejections.rowid AS id, receipt_id, record_rejections.owner_subject_id, connector_instance_id, connector_id, stream, run_id,
       first_run_id, latest_run_id,
       first_input_index, latest_input_index, reason_code, payload_sha256,
       payload_bytes, replay_count, status, accepted_run_id, accepted_record_key, accepted_at, created_at, last_seen_at,
       record_rejection_quota.pending_receipt_count,
       record_rejection_quota.pending_payload_bytes,
       (
         SELECT COUNT(*) FROM record_rejections AS connection_rejections
          WHERE connection_rejections.owner_subject_id = record_rejections.owner_subject_id
            AND connection_rejections.connector_instance_id = record_rejections.connector_instance_id
       ) AS connection_receipt_count
FROM record_rejections
JOIN record_rejection_quota ON record_rejection_quota.owner_subject_id = record_rejections.owner_subject_id
WHERE record_rejections.owner_subject_id = ?
  AND connector_instance_id = ?
ORDER BY created_at ASC, receipt_id ASC
LIMIT ?
