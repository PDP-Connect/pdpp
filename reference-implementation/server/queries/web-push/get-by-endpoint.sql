-- @terminator: one
SELECT id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at, last_success_at, last_failure_at, last_failure_reason, last_used_at, user_agent, platform, device_label
FROM web_push_subscriptions
WHERE endpoint = ?
LIMIT 1
