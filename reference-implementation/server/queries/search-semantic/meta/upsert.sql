-- @terminator: exec
INSERT INTO semantic_search_meta(connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_id, stream) DO UPDATE SET
  fields_fingerprint = excluded.fields_fingerprint,
  model_id           = excluded.model_id,
  dimensions         = excluded.dimensions,
  distance_metric    = excluded.distance_metric,
  updated_at         = excluded.updated_at
