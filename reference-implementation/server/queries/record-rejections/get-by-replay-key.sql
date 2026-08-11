-- @terminator: one
SELECT receipt_id
FROM record_rejections
WHERE replay_key = ?
LIMIT 1
