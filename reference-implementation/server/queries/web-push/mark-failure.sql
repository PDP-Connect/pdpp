-- @terminator: exec
UPDATE web_push_subscriptions
SET last_failure_at = ?,
    last_failure_reason = ?,
    last_used_at = ?,
    revoked_at = COALESCE(?, revoked_at),
    updated_at = ?
WHERE endpoint = ?
