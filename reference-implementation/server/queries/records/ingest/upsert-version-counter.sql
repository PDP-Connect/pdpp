-- @terminator: exec
-- Bump or insert the (connector_id, stream) max_version. Bind order is
-- (connector_id, stream, max_version) — `excluded.max_version` keeps
-- INSERT and ON CONFLICT semantically identical.
INSERT INTO version_counter(connector_id, stream, max_version)
VALUES(?, ?, ?)
ON CONFLICT(connector_id, stream) DO UPDATE SET max_version = excluded.max_version
