-- @terminator: exec
UPDATE pending_consents
SET status = 'approved',
    subject_id = ?,
    grant_id = ?,
    token_id = ?,
    ai_training_consented = ?,
    approved_at = ?
WHERE device_code = ?
