-- @terminator: one
-- Hydrate the persisted grant row used to bootstrap a continuous-mode
-- grant-scoped state lookup. Returns enough context to (a) reconstruct
-- the grant + storage_binding via requireResolvedPersistedGrantState
-- and (b) attach trace/scenario IDs to error replies.
SELECT grant_id AS persisted_grant_id,
       subject_id AS grant_subject_id,
       client_id AS grant_client_id,
       access_mode AS grant_access_mode,
       expires_at AS grant_expires_at,
       grant_json,
       storage_binding_json,
       trace_id,
       scenario_id
FROM grants
WHERE grant_id = ?
