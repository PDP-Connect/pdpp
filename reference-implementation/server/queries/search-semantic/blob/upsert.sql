-- @terminator: exec
INSERT INTO semantic_search_blob(connector_instance_id, connector_id, scope_key, record_key, embedding)
VALUES(?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id, scope_key, record_key) DO UPDATE SET
  connector_id = excluded.connector_id,
  embedding = excluded.embedding
