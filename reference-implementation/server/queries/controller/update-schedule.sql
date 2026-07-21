-- @terminator: exec
-- Apply a validated patch to an existing schedule row. Bumps updated_at
-- so the dashboard can show the most recent edit timestamp.
UPDATE connector_schedules
SET interval_seconds = ?, jitter_seconds = ?, enabled = ?, updated_at = ?
WHERE connector_instance_id = ?
