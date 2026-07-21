-- @terminator: many
-- @cursor_field: event_seq
-- Disclosure-spine timeline page for a trace correlation. Ordering is on
-- `event_seq`, the stable logical sequence assigned at append time. The
-- cursor contract is opaque to clients but, internally, only refers to
-- `event_seq` — never SQLite `rowid`.
-- Spec: openspec/changes/replace-spine-rowid-cursor-with-event-seq/specs/
--       reference-implementation-architecture/spec.md
SELECT event_seq AS id, *
FROM spine_events
WHERE trace_id = ?
  AND event_seq > ?
ORDER BY event_seq
LIMIT ?
