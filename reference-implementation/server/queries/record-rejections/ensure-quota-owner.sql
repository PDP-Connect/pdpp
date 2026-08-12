-- @terminator: exec
INSERT INTO record_rejection_quota(owner_subject_id, pending_payload_bytes, pending_receipt_count, updated_at)
VALUES(?, 0, 0, ?)
ON CONFLICT(owner_subject_id) DO NOTHING
