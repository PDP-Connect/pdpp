-- @terminator: one
SELECT subscription_id, grant_id, client_id, subject_id, callback_url,
       secret_hash, secret_text, scope_json, status, verification_challenge,
       created_at, updated_at, disabled_at, disabled_reason
FROM client_event_subscriptions
WHERE subscription_id = ?
