-- @terminator: many
-- @cursor_field: revision
-- Bounded: a connection accumulates config revisions only on owner/agent
-- edits, never per-run -- a small set (tens, not thousands) relative to
-- run history.
SELECT connector_instance_id, revision, config_json, config_contract_id, config_contract_version,
       option_kind, origin, is_explicit, status, collection_boundary_fingerprint,
       source_of_change, set_by, set_at, confirmed_by, confirmed_at
FROM connector_instance_config_revisions
WHERE connector_instance_id = ?
ORDER BY revision DESC
LIMIT ?;
