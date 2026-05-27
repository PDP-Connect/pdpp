-- @terminator: exec
INSERT OR IGNORE INTO client_event_queue(
  subscription_id, event_id, event_type, payload_json,
  enqueued_at, next_attempt_at, attempt_count, status
) VALUES(?, ?, ?, ?, ?, ?, 0, 'pending')
