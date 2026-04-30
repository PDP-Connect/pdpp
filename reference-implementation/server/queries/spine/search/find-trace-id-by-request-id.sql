-- @terminator: one
-- Small-cardinality fallback from request_id to the owning trace.
SELECT trace_id
FROM spine_events
WHERE request_id = ?
  AND trace_id IS NOT NULL
LIMIT 1
