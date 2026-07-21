-- @terminator: exec
-- Upsert the connector-scoped sync-state for one stream. Bind order is
-- (connector_id, connector_instance_id, stream, state_json, updated_at).
INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
VALUES(?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
  connector_id = excluded.connector_id,
  state_json = excluded.state_json,
  updated_at = excluded.updated_at
