-- @terminator: one
-- Real-world earliest/latest payload timestamps for one
-- (connector_id, stream), extracted from the manifest-declared
-- `consent_time_field` JSON path. Bind order is
-- (json_path_for_min, json_path_for_max, connector_id, stream); the
-- path string is validated by the caller to match
-- `^[A-Za-z_][A-Za-z0-9_]*$` so SQLite's parameter binding stays the
-- only source of value substitution.
SELECT
  MIN(json_extract(record_json, ?)) AS min_time,
  MAX(json_extract(record_json, ?)) AS max_time
FROM records
WHERE connector_id = ?
  AND stream = ?
  AND deleted = 0
