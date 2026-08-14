-- @terminator: one
SELECT COALESCE(SUM(payload_bytes), 0) AS bytes
FROM record_rejections
WHERE owner_subject_id = ?
  AND connector_instance_id = ?
