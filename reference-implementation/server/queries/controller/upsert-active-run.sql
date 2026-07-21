-- @terminator: exec
-- Persist the in-flight run for a connector instance.
--
-- Fail closed on connector_instance_id conflict: a live row already
-- present for the instance preserves the incumbent row rather than
-- replacing it. The controller decides whether the conflict is a neutral
-- defer outcome; the store only guarantees the durable gate.
INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at, run_generation)
VALUES(?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id) DO NOTHING
