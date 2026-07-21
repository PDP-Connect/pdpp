-- @terminator: exec
-- Hard-delete one connector_instances row by its primary key. The terminal step
-- of the connection-delete cascade, run LAST inside the same transaction after
-- every connection-scoped data/derived-state row has been erased. Keyed
-- strictly on connector_instance_id; ownership is verified by the caller BEFORE
-- this runs. Spec: add-owner-connection-delete-contract.
DELETE FROM connector_instances WHERE connector_instance_id = ?
