-- @terminator: exec
-- Upsert the grant-scoped sync-state for one stream. Bind order is
-- (grant_id, connector_id, stream, state_json, updated_at).
INSERT INTO grant_connector_state(grant_id, connector_id, stream, state_json, updated_at)
VALUES(?, ?, ?, ?, ?)
ON CONFLICT(grant_id, connector_id, stream) DO UPDATE SET
  state_json = excluded.state_json,
  updated_at = excluded.updated_at
