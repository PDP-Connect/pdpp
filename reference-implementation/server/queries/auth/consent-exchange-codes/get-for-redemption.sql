-- @terminator: one
SELECT c.code_hash, c.proof_hash, c.token_id, c.created_at, c.expires_at, c.redeemed_at,
       t.grant_id, t.package_id, t.revoked AS token_revoked,
       t.expires_at AS token_expires_at
FROM consent_exchange_codes c
JOIN tokens t ON t.token_id = c.token_id
WHERE c.code_hash = ?
