-- @terminator: one
SELECT fields_fingerprint, model_id, dimensions, distance_metric
FROM semantic_search_meta
WHERE connector_id = ? AND stream = ?
