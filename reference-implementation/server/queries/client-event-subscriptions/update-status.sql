-- @terminator: exec
UPDATE client_event_subscriptions
SET status = ?, updated_at = ?, disabled_at = ?, disabled_reason = ?
WHERE subscription_id = ?
