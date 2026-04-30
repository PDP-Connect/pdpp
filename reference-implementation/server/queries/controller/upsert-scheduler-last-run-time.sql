-- @terminator: exec
-- Persist the scheduler's per-connector interval gate timestamp.
INSERT INTO scheduler_last_run_times(connector_id, last_run_time_ms, updated_at)
VALUES(?, ?, ?)
ON CONFLICT(connector_id) DO UPDATE SET
  last_run_time_ms = excluded.last_run_time_ms,
  updated_at = excluded.updated_at
