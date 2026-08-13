-- @terminator: one
SELECT COUNT(*) AS count
FROM record_rejections
WHERE owner_subject_id = ?
  AND connector_instance_id = ?
