-- @terminator: exec
UPDATE record_rejections
SET status = 'stale_after_acceptance',
    accepted_run_id = ?,
    accepted_record_key = ?,
    accepted_at = ?,
    last_seen_at = ?
WHERE owner_subject_id = ?
  AND connector_instance_id = ?
  AND connector_id = ?
  AND stream = ?
  AND payload_sha256 = ?
  AND status = 'pending'
