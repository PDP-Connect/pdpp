-- @terminator: exec
UPDATE oauth_authorization_codes
SET status = 'consumed',
    consumed_at = ?
WHERE code = ? AND status = 'issued' AND consumed_at IS NULL
