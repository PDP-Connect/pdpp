-- @terminator: exec
-- Clear the persisted active-run row for a (connector_id, run_id) pair
-- once the controller-managed run has resolved (success, failure, or
-- restart-driven reconciliation). The `run_id` predicate guards against
-- racing a still-active row that overwrote the previous one.
DELETE FROM controller_active_runs
WHERE connector_id = ?
  AND run_id = ?
