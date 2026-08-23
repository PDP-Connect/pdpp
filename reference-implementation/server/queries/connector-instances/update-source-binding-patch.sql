-- @terminator: exec
-- Sibling of `update-status-with-binding-patch.sql` for a caller that records a
-- durable fact about a connection WITHOUT changing its status. `json_patch`
-- merges the given single-key object onto whatever `source_binding_json`
-- already holds, so an owner acknowledgement (`acknowledged_loss`) is stamped
-- at the moment the owner states it, never as a best-effort follow-up write and
-- never by clobbering a sibling key.
--
-- An acknowledged permanent loss does NOT revoke or pause the connection: the
-- source keeps whatever data it holds and keeps collecting anything still
-- reachable. That is exactly why this cannot reuse the status-write path.
UPDATE connector_instances
SET updated_at = ?,
    source_binding_json = json_patch(source_binding_json, json(?))
WHERE connector_instance_id = ?;
