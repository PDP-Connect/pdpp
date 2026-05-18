-- @terminator: many
-- @cursor_field: id
SELECT id, record_key, record_json
FROM records
WHERE connector_instance_id = ?
  AND stream = ?
  AND deleted = 0
  AND id > ?
ORDER BY id ASC
LIMIT ?
