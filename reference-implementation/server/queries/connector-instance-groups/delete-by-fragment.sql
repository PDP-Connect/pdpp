-- @terminator: exec
-- Rollback primitive: removing the alias row un-groups the fragment. This is
-- the entire rollback story for the alias/read-model approach -- no other
-- table is ever touched by grouping, so deleting this row is a complete and
-- safe reversal.
DELETE FROM connector_instance_groups WHERE connector_instance_id = ?;
