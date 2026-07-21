-- @terminator: exec
-- Insert a fresh record or update its payload, version, and emitted_at
-- on conflict, clearing the soft-delete flags so a previously-deleted
-- (connector_instance_id, stream, record_key) can be re-ingested.
INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, semantic_time)
VALUES(?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id, stream, record_key) DO UPDATE SET
  connector_id = excluded.connector_id,
  record_json = excluded.record_json,
  emitted_at = excluded.emitted_at,
  version = excluded.version,
  semantic_time = excluded.semantic_time,
  deleted = 0,
  deleted_at = NULL
