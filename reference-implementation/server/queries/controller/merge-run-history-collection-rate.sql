-- @terminator: exec
-- Merge `collection_rate` into a still-running run's `facts_json` at each
-- `run.progress_reported` event, so the product LIST/detail composition
-- can read the adaptive-rate-controller snapshot from the already-batched
-- `run_history` row instead of a per-run spine read (G1). `WHERE run_id =
-- ? AND status = 'running'` is the fence: once the terminal event has
-- finalized the row, this UPDATE matches zero rows and is a silent no-op
-- -- a concurrent/later terminal write always wins, never overwritten by
-- a stale in-flight progress update. json_patch merges onto whatever
-- facts_json already holds (NULL for a row that has not yet reported
-- progress), leaving every other key untouched.
UPDATE run_history
SET facts_json = json_patch(COALESCE(facts_json, '{}'), json(?))
WHERE run_id = ?
  AND status = 'running'
