-- @terminator: one
-- Inbound fragment count for a canonical connector instance: how many rows
-- name this id as their canonical identity. The delete path reads this to
-- refuse deleting a canonical that fragments still point at, which would
-- otherwise dangle those group rows (there is no FK to connector_instances)
-- and hide every fragment's records behind a canonical that is not there.
SELECT COUNT(*) AS fragment_count
FROM connector_instance_groups
WHERE canonical_connector_instance_id = ?;
