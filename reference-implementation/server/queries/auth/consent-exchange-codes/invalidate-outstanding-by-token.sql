-- @terminator: exec
UPDATE consent_exchange_codes
SET redeemed_at = ?, expires_at = ?
WHERE token_id = ? AND redeemed_at IS NULL
