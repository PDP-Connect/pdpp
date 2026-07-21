-- @terminator: exec
UPDATE grants SET consumed = 1 WHERE grant_id = ?
