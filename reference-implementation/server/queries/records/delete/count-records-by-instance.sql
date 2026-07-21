-- @terminator: one
-- Count of every row (live + soft-deleted) across all streams for one
-- connector_instance_id. Used by the connection-delete cascade to report how
-- many records it erased in the non-secret deletion summary. Spec:
-- add-owner-connection-delete-contract.
SELECT COUNT(*) AS count
FROM records
WHERE connector_instance_id = ?
