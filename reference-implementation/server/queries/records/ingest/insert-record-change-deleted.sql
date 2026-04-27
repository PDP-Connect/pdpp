-- @terminator: exec
-- Append a deletion entry to record_changes. The bound payload preserves
-- the record_json captured before deletion so /changes consumers can
-- still see what the row looked like at deletion time.
INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
VALUES(?, ?, ?, ?, ?, ?, 1, ?)
