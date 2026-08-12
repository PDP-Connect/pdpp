-- @terminator: exec
UPDATE record_rejection_quota
SET pending_payload_bytes = pending_payload_bytes + ?,
    pending_receipt_count = pending_receipt_count + 1,
    updated_at = ?
WHERE owner_subject_id = ?
  AND pending_payload_bytes + ? <= ?
  AND pending_receipt_count + 1 <= ?
