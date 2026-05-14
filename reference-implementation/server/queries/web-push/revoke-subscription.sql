-- @terminator: exec
UPDATE web_push_subscriptions
SET revoked_at = ?,
    updated_at = ?
WHERE owner_subject_id = ?
  AND endpoint = ?
