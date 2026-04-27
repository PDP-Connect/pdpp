-- @terminator: exec
DELETE FROM semantic_search_backfill_progress
WHERE connector_id = ? AND stream = ?
