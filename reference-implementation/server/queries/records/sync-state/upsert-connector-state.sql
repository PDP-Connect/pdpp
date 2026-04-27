-- @terminator: exec
-- Upsert the connector-scoped sync-state for one stream. Bind order is
-- (connector_id, stream, state_json, updated_at).
INSERT INTO connector_state(connector_id, stream, state_json, updated_at)
VALUES(?, ?, ?, ?)
ON CONFLICT(connector_id, stream) DO UPDATE SET
  state_json = excluded.state_json,
  updated_at = excluded.updated_at
