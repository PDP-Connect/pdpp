-- @terminator: one
SELECT fields_fingerprint
FROM lexical_search_meta
WHERE connector_id = ? AND stream = ?
