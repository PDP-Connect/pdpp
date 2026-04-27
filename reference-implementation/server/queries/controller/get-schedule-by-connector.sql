-- @terminator: one
-- Hydrate the persisted schedule row for a single connector. Returns
-- null when the connector has never had a schedule upserted.
SELECT connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
FROM connector_schedules
WHERE connector_id = ?
