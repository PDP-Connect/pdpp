-- @terminator: iterate
-- @cursor_field: record_key
-- Stream live records for one (connector_id, stream) ordered by
-- record_key. Consumed by `aggregateRecords` to compute count / sum /
-- min / max / group_by aggregations in JS — the iterator is exhausted
-- on every aggregation request. Pagination is the caller's
-- responsibility; the wrapper does not impose a cap because the
-- aggregation must see every visible row to be correct.
SELECT record_key, record_json
FROM records
WHERE connector_id = ?
  AND stream = ?
  AND deleted = 0
ORDER BY record_key ASC
