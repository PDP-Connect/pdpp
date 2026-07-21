-- @terminator: exec
-- Repair manifest-derived facts after a processing retry resolved the current
-- authoritative row. This is version-free and intentionally excludes deleted
-- tombstones, whose search state is repaired by delete operations.
UPDATE records
   SET semantic_time = ?
 WHERE connector_instance_id = ?
   AND stream = ?
   AND record_key = ?
   AND deleted = 0
