-- @terminator: exec_one
-- Atomically allocate the next stream version for a (connector_instance_id, stream)
-- pair. Bind order is (connector_id, connector_instance_id, stream). The first allocation creates
-- the row at max_version = 1; subsequent allocations bump the row by 1.
-- Returns the freshly-allocated max_version as a single row via SQL
-- RETURNING, so callers never read the counter and write it separately.
-- The terminator is exec_one (mutation-returning-one), not one (pure read);
-- this keeps the registry honest about the fact that the statement mutates
-- `version_counter`. Collapses the old read-then-write pattern into one
-- durable statement that is safe for any writer model (SQLite serial
-- writers today; PostgreSQL-compatible adapters in the future).
INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
VALUES(?, ?, ?, 1)
ON CONFLICT(connector_instance_id, stream) DO UPDATE
  SET max_version = version_counter.max_version + 1
RETURNING max_version
