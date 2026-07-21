-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: client_event_queue
-- @max_rows: 256
SELECT q.queue_id, q.subscription_id, q.event_id, q.event_type, q.payload_json,
       q.enqueued_at, q.next_attempt_at, q.attempt_count, q.status,
       s.callback_url, s.secret_text, s.verification_challenge,
       s.status AS subscription_status
FROM client_event_queue q
JOIN client_event_subscriptions s ON s.subscription_id = q.subscription_id
WHERE q.status = 'pending' AND q.next_attempt_at <= ?
ORDER BY q.next_attempt_at ASC
