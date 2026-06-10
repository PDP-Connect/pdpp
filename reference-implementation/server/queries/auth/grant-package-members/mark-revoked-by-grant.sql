-- @terminator: exec
UPDATE grant_package_members
SET status = 'revoked',
    revoked_at = ?
WHERE package_id = ?
  AND grant_id = ?
  AND status = 'active'
