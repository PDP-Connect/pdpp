-- @terminator: exec
UPDATE tokens SET revoked = 1 WHERE package_id = ?
