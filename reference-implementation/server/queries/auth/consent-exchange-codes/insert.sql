-- @terminator: exec
INSERT INTO consent_exchange_codes(
  code_hash, proof_hash, token_id, created_at, expires_at, redeemed_at
) VALUES(?, ?, ?, ?, ?, NULL)
