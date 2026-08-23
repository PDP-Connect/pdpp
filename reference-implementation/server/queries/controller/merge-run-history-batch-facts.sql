-- @terminator: exec
-- Preserve the highest durable emitted count reported by a committed ingest
-- batch while the run is still active. The run/connector-instance fence is
-- required because run_id is not globally unique across connections.
UPDATE run_history
SET records_emitted = MAX(
      records_emitted,
      CAST(json_extract(json(?), '$.records_emitted') AS INTEGER)
    ),
    facts_json = json_patch(COALESCE(facts_json, '{}'), json(?))
WHERE run_id = ?
  AND connector_instance_id = ?
  AND status = 'running'
