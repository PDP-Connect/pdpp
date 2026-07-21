-- @terminator: exec
-- Toggle the enabled flag on an existing schedule without touching the
-- interval/jitter fields. Bumps updated_at so the projection reflects
-- the pause/resume action.
UPDATE connector_schedules
SET enabled = ?, updated_at = ?
WHERE connector_instance_id = ?
