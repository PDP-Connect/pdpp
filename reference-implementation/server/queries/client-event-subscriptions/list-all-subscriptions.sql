-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: client_event_subscriptions
-- @max_rows: 1024
-- Operator-facing read across every grant on the instance. Each optional
-- filter parameter is bound TWICE (once for the IS NULL check, once for
-- the equality check) so callers can pass NULL to disable a filter while
-- keeping the binding count stable. The SmallEnumerationQuery bound is
-- generous (1024) because reference instances are local and the operator
-- dashboard does not paginate this list — but the bound still trips the
-- safety net if a deployment grows past it, at which point the operator
-- list needs cursor pagination (see openspec/changes/add-client-event-
-- subscription-management/ residual risks).
SELECT subscription_id, authority_kind, grant_id, client_id, subject_id, callback_url,
       secret_hash, secret_text, scope_json, status, verification_challenge,
       created_at, updated_at, disabled_at, disabled_reason
FROM client_event_subscriptions
WHERE status != 'deleted'
  AND (? IS NULL OR client_id = ?)
  AND (? IS NULL OR grant_id = ?)
  AND (? IS NULL OR status = ?)
ORDER BY created_at DESC, subscription_id ASC
