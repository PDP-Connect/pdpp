-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: owner_device_auth
-- @max_rows: 256
-- All non-expired pending owner CLI device-flow authorizations, used
-- alongside list-pending-consents.sql by `/_ref/approvals`. Bounded by
-- the count of in-flight CLI logins; the `expires_at > ?` predicate
-- prevents long-uptime drift.
SELECT device_code, user_code, client_id, created_at, approval_id
FROM owner_device_auth
WHERE status = 'pending'
  AND expires_at > ?
ORDER BY created_at DESC
