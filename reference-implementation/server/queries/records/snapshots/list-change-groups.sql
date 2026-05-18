-- @terminator: iterate
-- @cursor_field: latest_version
-- One row per record_key whose changes fall in the (after, max] window,
-- with the highest matching version per key. Bind order is
-- (connector_instance_id, stream, after_version, session_max_version). The
-- caller batches by reading until the desired (limit + 1) visible
-- groups are collected or the iterator is exhausted, then re-issues
-- with `pageAfterVersion` advanced to the last seen `latest_version`.
SELECT record_key, MAX(version) AS latest_version
FROM record_changes
WHERE connector_instance_id = ?
  AND stream = ?
  AND version > ?
  AND version <= ?
GROUP BY record_key
ORDER BY latest_version ASC
