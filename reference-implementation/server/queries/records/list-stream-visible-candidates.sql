-- @terminator: iterate
-- @cursor_field: record_key
-- Candidate records for grant-visible stream summaries. Authorization,
-- resource, and consent-time filtering stays in JS because the grant shape
-- controls those predicates per stream.
SELECT record_key, record_json, emitted_at
FROM records
WHERE connector_id = ?
  AND stream = ?
  AND deleted = 0
ORDER BY record_key ASC
