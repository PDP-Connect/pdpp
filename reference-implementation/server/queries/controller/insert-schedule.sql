-- @terminator: exec
-- Insert a new schedule row when upsertSchedule observes no existing
-- entry for this connector. Paired with update-schedule.sql at the call
-- site (controller.ts upsertSchedule); the two-query pattern is kept so
-- the existence check can drive logging / projection differences.
INSERT INTO connector_schedules(
  connector_instance_id, connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
) VALUES(?, ?, ?, ?, ?, ?, ?)
