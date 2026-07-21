-- @terminator: many
-- @cursor_field: rowid
SELECT rowid FROM semantic_search_rowid
WHERE connector_id = ?
  AND scope_key = ?
  AND rowid > ?
ORDER BY rowid ASC
LIMIT ?
