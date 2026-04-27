-- @terminator: exec
UPDATE tokens SET revoked = 1 WHERE grant_id = ?
