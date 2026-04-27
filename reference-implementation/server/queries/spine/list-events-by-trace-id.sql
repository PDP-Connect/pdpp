-- @terminator: many
-- @cursor_field: rowid
SELECT rowid, *
FROM spine_events
WHERE trace_id = ?
  AND rowid > ?
ORDER BY rowid
LIMIT ?
