-- @terminator: exec
UPDATE web_push_subscriptions
SET last_success_at = ?,
    last_used_at = ?,
    last_failure_reason = NULL,
    updated_at = ?
WHERE endpoint = ?
