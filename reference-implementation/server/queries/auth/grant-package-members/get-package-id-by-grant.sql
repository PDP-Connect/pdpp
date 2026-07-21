-- @terminator: one
-- Resolve a child grant id to its parent package id, if any. The
-- protocol-binding fact lives on `grant_package_members.grant_id`; the
-- package's MCP token row carries `package_id` with a NULL grant_id and
-- therefore does NOT participate in this lookup. A child grant joined
-- here is the per-source bearer issued atomically with the package at
-- approval time.
SELECT package_id
FROM grant_package_members
WHERE grant_id = ?
ORDER BY added_at
LIMIT 1
