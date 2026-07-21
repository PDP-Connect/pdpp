-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: client_event_attempts
-- @max_rows: 64
SELECT attempt_id, queue_id, attempted_at, status_code, ok, latency_ms, error, response_snippet
FROM client_event_attempts
WHERE queue_id = ?
ORDER BY attempt_id ASC
