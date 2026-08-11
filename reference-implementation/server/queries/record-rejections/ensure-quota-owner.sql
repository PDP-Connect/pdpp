-- @terminator: exec
INSERT INTO record_rejection_quota(owner_subject_id, pending_payload_bytes, updated_at)
VALUES(?, 0, ?)
ON CONFLICT(owner_subject_id) DO NOTHING
