-- @terminator: exec
UPDATE record_rejection_quota
SET pending_payload_bytes = pending_payload_bytes - ?,
    pending_receipt_count = pending_receipt_count - ?,
    updated_at = ?
WHERE owner_subject_id = ?
