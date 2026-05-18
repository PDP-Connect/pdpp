-- @terminator: many
-- @cursor_field: rowid
SELECT rowid, connector_instance_id, scope_key, record_key
FROM semantic_search_rowid
WHERE connector_id = ?
  AND scope_key LIKE ?
  AND rowid > ?
ORDER BY rowid ASC
LIMIT ?
