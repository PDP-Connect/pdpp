-- @terminator: exec
-- Remove the schedule row for a connector. The caller verifies the row
-- existed before calling delete; subsequent calls return false because
-- the existence check fires before the DELETE.
DELETE FROM connector_schedules
WHERE connector_id = ?
