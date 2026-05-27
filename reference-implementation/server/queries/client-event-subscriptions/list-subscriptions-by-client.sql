-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: client_event_subscriptions
-- @max_rows: 256
SELECT subscription_id, grant_id, client_id, subject_id, callback_url,
       secret_hash, secret_text, scope_json, status, verification_challenge,
       created_at, updated_at, disabled_at, disabled_reason
FROM client_event_subscriptions
WHERE client_id = ?
ORDER BY created_at ASC
