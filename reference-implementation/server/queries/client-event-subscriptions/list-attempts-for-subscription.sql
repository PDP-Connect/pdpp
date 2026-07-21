-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: client_event_attempts
-- @max_rows: 100
-- Operator-facing read of the most recent attempts for a subscription
-- (across all queue rows it has produced). The operation layer caps the
-- caller-visible result at 25; the SQL bound is 100 to give the operation
-- a little room to filter without re-issuing the query.
SELECT a.attempt_id,
       a.queue_id,
       q.event_id,
       q.event_type,
       a.attempted_at,
       a.status_code,
       a.ok,
       a.latency_ms,
       a.error,
       a.response_snippet
FROM client_event_attempts a
JOIN client_event_queue q ON q.queue_id = a.queue_id
WHERE q.subscription_id = ?
ORDER BY a.attempt_id DESC
LIMIT ?
