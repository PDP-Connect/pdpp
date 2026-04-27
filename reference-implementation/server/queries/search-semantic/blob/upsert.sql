-- @terminator: exec
INSERT INTO semantic_search_blob(connector_id, scope_key, record_key, embedding)
VALUES(?, ?, ?, ?)
ON CONFLICT(connector_id, scope_key, record_key) DO UPDATE SET
  embedding = excluded.embedding
