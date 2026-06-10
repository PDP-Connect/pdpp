-- @terminator: exec
INSERT INTO client_event_attempts(
  queue_id, attempted_at, status_code, ok, latency_ms, error, response_snippet
) VALUES(?, ?, ?, ?, ?, ?, ?)
