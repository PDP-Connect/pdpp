-- @terminator: one
SELECT
  source_id,
  event_id,
  body_hash,
  connector_id,
  connector_instance_id,
  owner_subject_id,
  action,
  run_id,
  trace_id,
  automation_mode,
  automation_summary,
  started_at
FROM source_webhook_run_receipts
WHERE source_id = ?
  AND event_id = ?
