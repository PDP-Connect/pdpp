-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: web_push_subscriptions
-- @max_rows: 512
SELECT id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at, last_success_at, last_failure_at, last_failure_reason, last_used_at, user_agent, platform, device_label
FROM web_push_subscriptions
WHERE owner_subject_id = ?
  AND revoked_at IS NULL
ORDER BY updated_at DESC, id ASC
