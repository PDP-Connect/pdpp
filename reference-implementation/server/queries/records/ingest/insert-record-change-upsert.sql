-- @terminator: exec
-- Append a non-deletion change-log entry. `deleted=0` and
-- `deleted_at=NULL` mark the row as a live-write event in the changes
-- feed.
INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
VALUES(?, ?, ?, ?, ?, ?, 0, NULL)
