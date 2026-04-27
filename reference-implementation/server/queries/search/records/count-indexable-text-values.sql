-- @terminator: one
-- Counts non-deleted records whose record_json has a non-empty text value
-- at the requested JSON path. The path is bound twice — once for the
-- json_type assertion, once for the length check.
SELECT COUNT(*) AS n
FROM records
WHERE connector_id = ?
  AND stream = ?
  AND deleted = 0
  AND json_type(record_json, ?) = 'text'
  AND length(json_extract(record_json, ?)) > 0
