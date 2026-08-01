-- @terminator: exec
-- Clear the durable cadence anchor once synthesized evidence resolves
-- (evidence clears, or a probe succeeds) so the next fresh sighting starts
-- the streak (and initial delay) over.
DELETE FROM synthesized_revalidation_state
WHERE connector_instance_id = ?
