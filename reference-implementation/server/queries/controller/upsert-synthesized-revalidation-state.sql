-- @terminator: exec
-- Persist the scheduler's per-connector synthesized-revalidation cadence
-- anchor (pending-skip sighting or failed-probe attempt).
INSERT INTO synthesized_revalidation_state(connector_instance_id, connector_id, attempt, anchor_at, updated_at)
VALUES(?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id) DO UPDATE SET
  connector_id = excluded.connector_id,
  attempt = excluded.attempt,
  anchor_at = excluded.anchor_at,
  updated_at = excluded.updated_at
