-- @terminator: exec
UPDATE tokens
SET revoked = 1
WHERE refresh_family_id = ?
  AND revoked = 0
