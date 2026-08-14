-- @terminator: exec
UPDATE consent_exchange_codes
SET redeemed_at = ?
WHERE code_hash = ? AND redeemed_at IS NULL
