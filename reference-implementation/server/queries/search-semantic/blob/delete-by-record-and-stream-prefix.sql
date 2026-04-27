-- @terminator: exec
DELETE FROM semantic_search_blob
WHERE connector_id = ?
  AND record_key = ?
  AND scope_key LIKE ?
