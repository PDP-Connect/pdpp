-- @terminator: exec
UPDATE client_event_queue
SET attempt_count = ?, next_attempt_at = ?, status = ?, last_error = ?
WHERE queue_id = ?
