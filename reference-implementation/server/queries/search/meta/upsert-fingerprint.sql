-- @terminator: exec
INSERT INTO lexical_search_meta(connector_id, stream, fields_fingerprint, updated_at)
VALUES(?, ?, ?, ?)
ON CONFLICT(connector_id, stream) DO UPDATE SET
  fields_fingerprint = excluded.fields_fingerprint,
  updated_at = excluded.updated_at
