-- @terminator: exec
INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at)
VALUES(?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
  connector_id = excluded.connector_id,
  fields_fingerprint = excluded.fields_fingerprint,
  updated_at = excluded.updated_at
