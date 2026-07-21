-- @terminator: one
SELECT fields_fingerprint
FROM lexical_search_meta
WHERE connector_instance_id = ? AND stream = ?
