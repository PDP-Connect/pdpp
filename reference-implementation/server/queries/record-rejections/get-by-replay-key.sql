-- @terminator: one
SELECT receipt_id, reason_code, payload_sha256, payload_bytes, created_at
FROM record_rejections
WHERE replay_key = ?
LIMIT 1
