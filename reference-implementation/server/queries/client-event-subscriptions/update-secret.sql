-- @terminator: exec
UPDATE client_event_subscriptions
SET secret_hash = ?, secret_text = ?, updated_at = ?
WHERE subscription_id = ?
