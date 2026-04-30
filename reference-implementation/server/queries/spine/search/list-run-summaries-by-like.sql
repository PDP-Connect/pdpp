-- @terminator: many
-- @cursor_field: last_at
-- Fuzzy run-correlation matches for disclosure-spine search. The rowid
-- projection is an event_seq tiebreaker used only by the bounded wrapper if
-- more than the requested page exists; callers ignore the returned cursor.
SELECT
  run_id AS id,
  MAX(occurred_at) AS last_at,
  MAX(event_seq) AS rowid
FROM spine_events
WHERE run_id IS NOT NULL
  AND run_id LIKE ?
GROUP BY run_id
ORDER BY last_at DESC, rowid DESC
LIMIT ?
