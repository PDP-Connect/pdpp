-- @terminator: exec
UPDATE tokens
SET refresh_family_id = ?,
    expires_at = ?
WHERE token_id = ?
  AND refresh_family_id IS NULL
