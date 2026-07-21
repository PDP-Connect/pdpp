-- @terminator: exec
UPDATE grant_packages
SET status = 'revoked',
    revoked_at = ?
WHERE package_id = ? AND status = 'active'
