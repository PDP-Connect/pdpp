-- @terminator: exec
-- Clear the persisted active-run row for a (connector_instance_id, run_id)
-- pair once the controller-managed run has resolved (success, failure, or
-- restart-driven reconciliation). The `run_id` predicate guards against
-- racing a still-active row that overwrote the previous one.
--
-- The final NULL-compatible branch lets post-migration reconciliation drain
-- legacy/test rows that predate connector_instance_id without weakening the
-- normal instance-scoped guard.
DELETE FROM controller_active_runs
WHERE run_id = ?
  AND (
    connector_instance_id = ?
    OR (connector_instance_id IS NULL AND connector_id = ?)
  )
