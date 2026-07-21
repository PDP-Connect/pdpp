-- @terminator: exec
INSERT INTO connectors(connector_id, manifest)
VALUES(?, ?)
ON CONFLICT(connector_id) DO NOTHING
