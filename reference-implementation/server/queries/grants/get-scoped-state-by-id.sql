-- @terminator: one
-- Hydrate the persisted grant row used to bootstrap a continuous-mode
-- grant-scoped state lookup. Returns enough context to (a) reconstruct
-- the grant + storage_binding via requireResolvedPersistedGrantState
-- and (b) attach trace/scenario IDs to error replies.
SELECT grant_json, storage_binding_json, trace_id, scenario_id
FROM grants
WHERE grant_id = ?
