-- @terminator: exec
INSERT INTO connector_state(
  connector_id, connector_instance_id, stream, state_json, updated_at, manifest_generation
)
VALUES(?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
  connector_id = excluded.connector_id,
  state_json = excluded.state_json,
  updated_at = excluded.updated_at,
  manifest_generation = excluded.manifest_generation;
