-- @terminator: one
SELECT snapshot_id, query, plan_hash, results_json, created_at
FROM lexical_search_snapshots
WHERE snapshot_id = ?
