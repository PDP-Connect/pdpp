-- @terminator: one
SELECT fields_fingerprint, model_id, dimensions, distance_metric
FROM semantic_search_backfill_progress
WHERE connector_instance_id = ? AND stream = ?
