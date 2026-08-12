-- @terminator: exec
UPDATE record_rejections
SET replay_count = MIN(replay_count + 1, ?),
    latest_input_index = ?,
    last_seen_at = ?
WHERE receipt_id = ?
