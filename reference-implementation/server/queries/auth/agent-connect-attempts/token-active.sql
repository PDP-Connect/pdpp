-- @terminator: one
SELECT 1 AS ok
FROM tokens
WHERE token_id = ?
  AND revoked = 0
  AND (expires_at IS NULL OR expires_at > ?)
LIMIT 1
