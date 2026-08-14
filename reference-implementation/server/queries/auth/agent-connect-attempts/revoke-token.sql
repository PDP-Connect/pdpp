-- @terminator: exec
UPDATE tokens
   SET revoked = 1
 WHERE token_id = ?
   AND revoked = 0
