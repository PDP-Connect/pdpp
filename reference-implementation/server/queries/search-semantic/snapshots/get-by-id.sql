-- @terminator: one
SELECT snapshot_id, query, plan_hash, results_json, created_at
FROM semantic_search_snapshots
WHERE snapshot_id = ?
