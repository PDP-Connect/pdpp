-- @terminator: exec
INSERT INTO client_event_subscriptions(
  subscription_id, authority_kind, grant_id, client_id, subject_id, callback_url,
  secret_hash, secret_text, scope_json, status, verification_challenge,
  created_at, updated_at
) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
