-- @terminator: one
-- Operator-facing detail join. Surfaces pending-queue count, final-failure
-- count, and the most recent attempt for one subscription. The join layout
-- mirrors `claim-due-queue.sql` so the operator detail view never N+1s the
-- attempt log when rendering the summary fields.
SELECT s.subscription_id,
       s.authority_kind,
       s.grant_id,
       s.client_id,
       s.subject_id,
       s.callback_url,
       s.scope_json,
       s.status,
       s.created_at,
       s.updated_at,
       s.disabled_at,
       s.disabled_reason,
       (SELECT COUNT(*) FROM client_event_queue q
          WHERE q.subscription_id = s.subscription_id
            AND q.status = 'pending') AS pending_queue_count,
       (SELECT COUNT(*) FROM client_event_queue q
          WHERE q.subscription_id = s.subscription_id
            AND q.status = 'final_failure') AS final_failure_count,
       (SELECT a.attempted_at FROM client_event_attempts a
          JOIN client_event_queue q ON q.queue_id = a.queue_id
          WHERE q.subscription_id = s.subscription_id
          ORDER BY a.attempt_id DESC LIMIT 1) AS last_attempted_at,
       (SELECT a.ok FROM client_event_attempts a
          JOIN client_event_queue q ON q.queue_id = a.queue_id
          WHERE q.subscription_id = s.subscription_id
          ORDER BY a.attempt_id DESC LIMIT 1) AS last_attempt_ok,
       (SELECT a.status_code FROM client_event_attempts a
          JOIN client_event_queue q ON q.queue_id = a.queue_id
          WHERE q.subscription_id = s.subscription_id
          ORDER BY a.attempt_id DESC LIMIT 1) AS last_attempt_status_code
FROM client_event_subscriptions s
WHERE s.subscription_id = ?
  AND s.status != 'deleted'
