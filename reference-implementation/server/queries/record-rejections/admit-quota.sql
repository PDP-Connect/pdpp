-- @terminator: exec
UPDATE record_rejection_quota
SET pending_payload_bytes = pending_payload_bytes + ?,
    updated_at = ?
WHERE owner_subject_id = ?
  AND pending_payload_bytes + ? <= ?
