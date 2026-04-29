-- @terminator: one
-- Atomically allocate the next stream version for a (connector_id, stream)
-- pair. Bind order is (connector_id, stream). The first allocation creates
-- the row at max_version = 1; subsequent allocations bump the row by 1.
-- Returns the freshly-allocated max_version as a single row, so callers
-- never read the counter and write it separately. This collapses the old
-- read-then-write pattern into one durable statement that is safe for any
-- writer model (SQLite serial writers today; PostgreSQL-compatible
-- adapters in the future).
INSERT INTO version_counter(connector_id, stream, max_version)
VALUES(?, ?, 1)
ON CONFLICT(connector_id, stream) DO UPDATE
  SET max_version = version_counter.max_version + 1
RETURNING max_version
