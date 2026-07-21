-- @terminator: exec
INSERT INTO web_push_subscriptions(
  id, owner_subject_id, endpoint, p256dh, auth, created_at, updated_at, revoked_at,
  user_agent, platform, device_label
) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
ON CONFLICT(endpoint) DO UPDATE SET
  owner_subject_id = excluded.owner_subject_id,
  p256dh = excluded.p256dh,
  auth = excluded.auth,
  updated_at = excluded.updated_at,
  revoked_at = NULL,
  user_agent = excluded.user_agent,
  platform = excluded.platform,
  device_label = excluded.device_label
