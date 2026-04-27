-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: pending_consents
-- @max_rows: 256
-- All non-expired pending device-flow consent requests, used by the
-- dashboard's `/_ref/approvals` projection. Bounded by the count of
-- in-flight consent prompts (a human-driven queue measured in dozens
-- under realistic load); the `expires_at > ?` predicate trims away
-- stale rows so the bound holds even after long uptime.
SELECT device_code, user_code, params_json, created_at
FROM pending_consents
WHERE status = 'pending'
  AND expires_at > ?
ORDER BY created_at DESC
