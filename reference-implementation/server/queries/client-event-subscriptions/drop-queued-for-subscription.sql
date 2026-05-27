-- @terminator: exec
DELETE FROM client_event_queue WHERE subscription_id = ? AND status = 'pending'
