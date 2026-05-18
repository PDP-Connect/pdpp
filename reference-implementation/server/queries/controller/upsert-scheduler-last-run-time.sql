-- @terminator: exec
-- Persist the scheduler's per-connector interval gate timestamp.
INSERT INTO scheduler_last_run_times(connector_instance_id, connector_id, last_run_time_ms, updated_at)
VALUES(?, ?, ?, ?)
ON CONFLICT(connector_instance_id) DO UPDATE SET
  connector_id = excluded.connector_id,
  last_run_time_ms = excluded.last_run_time_ms,
  updated_at = excluded.updated_at
