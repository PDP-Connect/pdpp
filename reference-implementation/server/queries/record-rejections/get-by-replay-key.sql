-- @terminator: one
SELECT receipt_id, reason_code
FROM record_rejections
WHERE replay_key = ?
LIMIT 1
