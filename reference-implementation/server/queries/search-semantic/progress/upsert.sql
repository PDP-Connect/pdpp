-- @terminator: exec
INSERT INTO semantic_search_backfill_progress(connector_instance_id, connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
  connector_id         = excluded.connector_id,
  fields_fingerprint = excluded.fields_fingerprint,
  model_id           = excluded.model_id,
  dimensions         = excluded.dimensions,
  distance_metric    = excluded.distance_metric,
  updated_at         = excluded.updated_at
