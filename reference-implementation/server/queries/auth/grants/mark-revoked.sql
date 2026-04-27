-- @terminator: exec
UPDATE grants SET status = 'revoked' WHERE grant_id = ?
