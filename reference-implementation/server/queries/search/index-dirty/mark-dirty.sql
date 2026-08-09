-- @terminator: exec
-- Durably mark one (connector_instance_id, stream) scope dirty for
-- lexical/semantic index maintenance. Called from INSIDE the same durable
-- write transaction as the record mutation that caused it, so this insert
-- can never be lost between the durable commit and background index work.
-- connector_id is stored alongside so a later reconcile pass can look up
-- the connector's registered manifest without requiring a connector_instances
-- row to exist (direct-ingest callers may have none).
INSERT INTO search_index_dirty(connector_instance_id, connector_id, stream, dirty, marked_at)
VALUES(?, ?, ?, 1, ?)
ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
  connector_id = excluded.connector_id,
  dirty = 1,
  marked_at = excluded.marked_at
