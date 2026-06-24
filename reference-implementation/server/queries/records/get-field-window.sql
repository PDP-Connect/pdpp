-- @terminator: one
-- Bounded character window of one top-level string field of a single live
-- record, for the MCP content-ladder field-window substrate. The JSON path is
-- bound (`?` parameters 1-5), so the field name never reaches the SQL text and
-- a key containing `.` or `"` resolves to that literal top-level key. Only the
-- windowed substring and the field's total length cross out of SQLite — the
-- full `record_json` is never selected. The caller layers grant field-scope,
-- resource, time-range, and connection enforcement on top before issuing this
-- read and before returning bytes.
--
-- The consent-time projection (param 6) lets the caller enforce the grant's
-- time-range without hydrating `record_json`; it resolves to NULL when the
-- stream declares no consent_time_field.
--
-- Positional parameters, in SQL order:
--   1  field json path   (json_type for field_type)
--   2  field json path   (json_extract for field_text)
--   3  consent-time json path (time-range projection; NULL path -> NULL)
--   4  connector_instance_id
--   5  stream
--   6  record_key
--   7  query string      (NULL for offset selector; instr guard)
--   8  query string      (NULL for offset selector; instr value)
--   9  query string      (NULL for offset selector; output guard)
--   10 query string      (NULL for offset selector; start expression)
--   11 before chars      (query selector context)
--   12 offset start      (1-based; offset selector only)
--   13 substr length
WITH selected AS (
  SELECT
    record_key,
    json_type(record_json, ?) AS field_type,
    json_extract(record_json, ?) AS field_text,
    json_extract(record_json, ?) AS consent_time_value
  FROM records
  WHERE connector_instance_id = ?
    AND stream = ?
    AND record_key = ?
    AND deleted = 0
),
positioned AS (
  SELECT
    record_key,
    field_type,
    field_text,
    CASE WHEN field_type = 'text' THEN length(field_text) ELSE NULL END AS total_chars,
    CASE WHEN ? IS NOT NULL AND field_type = 'text' THEN instr(lower(field_text), lower(?)) ELSE NULL END AS match_pos,
    consent_time_value
  FROM selected
)
SELECT
  record_key,
  field_type,
  total_chars,
  CASE WHEN field_type = 'text' AND (? IS NULL OR match_pos > 0)
       THEN substr(field_text, CASE WHEN ? IS NOT NULL THEN max(1, match_pos - ?) ELSE ? END, ?)
       ELSE NULL END AS window_text,
  match_pos,
  consent_time_value
FROM positioned
