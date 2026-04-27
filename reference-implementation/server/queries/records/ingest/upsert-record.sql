-- @terminator: exec
-- Insert a fresh record or update its payload, version, and emitted_at
-- on conflict, clearing the soft-delete flags so a previously-deleted
-- (connector_id, stream, record_key) can be re-ingested.
INSERT INTO records(connector_id, stream, record_key, record_json, emitted_at, version)
VALUES(?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_id, stream, record_key) DO UPDATE SET
  record_json = excluded.record_json,
  emitted_at = excluded.emitted_at,
  version = excluded.version,
  deleted = 0,
  deleted_at = NULL
